import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import ts from 'typescript';
import { BUILD_PRICING_SHA256 } from '../../src/lib/api/pricingHash';
import { e2eLane, e2eLogin } from './global-setup';

// The contract test of the API client (task WEB01): the real `src/lib/api/client.ts`, running in Chromium on a page of the site's origin, against the lane's
// real API. It logs in, reads `me`, sends `activity`, reads two sync resources and a poll, and maps a JV_INVALID_INPUT, a JV_BAD_LOGIN, a JV_FORBIDDEN and a
// 401 through the client. (The forced retry with one key that makes one customer is the contract test of WEB07, where X6 exists.)
//
// The client is the TypeScript file itself: the test transpiles `src/lib/api/*.ts` and serves the result to the page at /__jv/<name>, so the page runs the
// code that the site will ship, with the browser's own fetch, cookie jar and CORS. Nothing is bundled or downloaded.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/api-client.spec.ts

const API_SOURCE = path.resolve(__dirname, '../../src/lib/api');
const MODULES = ['client', 'types', 'pricingHash'];

function compile(name: string): string {
  const source = readFileSync(path.join(API_SOURCE, `${name}.ts`), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

/** What the page keeps: the client under test and a counter of how many times its 401 hook ran. */
interface Jv {
  client: ReturnType<typeof import('../../src/lib/api/client').createApiClient>;
  unauthorized: number;
  attempt: (fn: () => Promise<unknown>) => Promise<Outcome>;
}
type Outcome =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: {
        name: string;
        code: string;
        status: number;
        message: string;
        details: Record<string, unknown>;
        requestId: string | null;
        nothingChanged: boolean;
        unconfirmed: boolean;
      };
    };
declare global {
  interface Window {
    __jv: Jv;
  }
}

/**
 * Opens a page of the dev server on the site's origin (so the browser sends the allowed Origin) and starts the client in it. The page is the dev server's own 404
 * document, on purpose: a page that the test itself fulfils has no address space for Chromium, which then asks permission before it lets the page call the API on
 * the loopback address ("Local Network Access"); a page the server sent is loopback itself, like the site on a developer's computer.
 */
async function openClient(page: Page): Promise<void> {
  const { apiUrl, webOrigin } = e2eLane();
  await page.route('**/__jv/**', async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname).replace(/\.js$/, '');
    if (MODULES.includes(name)) {
      await route.fulfill({ contentType: 'text/javascript', body: compile(name) });
    } else {
      await route.continue(); // the page itself: the dev server answers 404 with its own document
    }
  });
  await page.goto(`${webOrigin}/__jv/page`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import { createApiClient } from '/__jv/client.js';
      const client = createApiClient({ baseUrl: ${JSON.stringify(apiUrl)} });
      const jv = { client, unauthorized: 0 };
      client.onUnauthorized(() => { jv.unauthorized += 1; });
      jv.attempt = async (fn) => {
        try {
          return { ok: true, value: await fn() };
        } catch (e) {
          return { ok: false, error: { name: e.name, code: e.code, status: e.status, message: e.message, details: e.details,
            requestId: e.requestId, nothingChanged: e.nothingChanged, unconfirmed: e.unconfirmed } };
        }
      };
      window.__jv = jv;
    `,
  });
  await page.waitForFunction(() => Boolean(window.__jv));
}

type Method =
  | 'login'
  | 'me'
  | 'logout'
  | 'activity'
  | 'changePassword'
  | 'syncPage'
  | 'poll'
  | 'post';

/** Runs one method of the client in the page and gives back its value, or the fields of its ApiError. */
function call(page: Page, method: Method, ...args: unknown[]): Promise<Outcome> {
  return page.evaluate(
    ([name, values]) => {
      const client = window.__jv.client as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      return window.__jv.attempt(() => client[name as string](...(values as unknown[])));
    },
    [method, args] as [string, unknown[]]
  );
}

const ok = <T>(outcome: Outcome): T => {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return (outcome as { ok: true; value: unknown }).value as T;
};
const refused = (outcome: Outcome) => {
  expect(outcome.ok, 'the call should have been refused').toBe(false);
  return (outcome as { ok: false; error: Extract<Outcome, { ok: false }>['error'] }).error;
};

test.describe('WEB01 contract: the API client against the lane API, in a real browser', () => {
  test('logs in, reads me (the pricing hash matches the build), sends activity, reads sync pages and a poll', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await openClient(page);

    const login = ok<{
      user: Record<string, unknown>;
      idle_timeout_s: number;
      absolute_expires_at: string;
    }>(await call(page, 'login', owner.email, owner.password));
    expect(login.user).toMatchObject({
      email: owner.email,
      role: 'owner',
      must_change_password: false,
    });
    expect(login.idle_timeout_s).toBeGreaterThan(0);
    expect(login.absolute_expires_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);

    const me = ok<{ user: { role: string }; pricing_sha256: string | null }>(
      await call(page, 'me')
    );
    expect(me.user.role).toBe('owner');
    // C12: the API's copy of pricing.ts is the app's, byte for byte, so the hash of `me` is the build's own
    expect(me.pricing_sha256).toBe(BUILD_PRICING_SHA256);
    expect(await page.evaluate(() => window.__jv.client.getPricingCheck())).toEqual({
      state: 'match',
    });
    expect(await page.evaluate(() => window.__jv.client.savingBillsAllowed())).toBe(true);

    // no body, no Content-Type: an empty JSON body would be a 422
    expect(ok(await call(page, 'activity'))).toEqual({ ok: true });

    // keyset paging through the client: pages of 4 settings, each cursor sent back as the exact text it came in, until `next` is null
    type SettingsPage = {
      rows: Array<{ setting_key: string; value: unknown; updated_at: string }>;
      next: { updated_at: string; key: string } | null;
      server_time: string;
    };
    const keys: string[] = [];
    let cursor: SettingsPage['next'] = null;
    let pages = 0;
    do {
      const options: Record<string, unknown> = { limit: 4 };
      if (cursor) Object.assign(options, { updatedAfter: cursor.updated_at, afterKey: cursor.key });
      const page1 = ok<SettingsPage>(await call(page, 'syncPage', 'settings', options));
      expect(page1.server_time).toMatch(/\.\d{6}Z$/);
      for (const row of page1.rows) {
        expect(row.updated_at).toMatch(/\.\d{6}Z$/);
        keys.push(row.setting_key);
      }
      cursor = page1.next;
      pages += 1;
    } while (cursor && pages < 10);
    expect(cursor).toBeNull();
    expect(pages).toBeGreaterThan(1); // more than one page was needed, so the cursor really travelled
    expect(new Set(keys).size).toBe(keys.length); // each setting arrived once
    expect(keys).toEqual(expect.arrayContaining(['business', 'estimate', 'data_epoch']));

    const customers = ok<{ rows: Array<{ is_walkin: boolean; archived_at: string | null }> }>(
      await call(page, 'syncPage', 'customers')
    );
    expect(customers.rows.some((c) => c.is_walkin === true)).toBe(true);

    const poll = ok<{
      results: Record<string, { rows: unknown[]; next: unknown }>;
      role: string;
      server_time: string;
    }>(
      await call(page, 'poll', { settings: null, 'sku-private': null, 'customer-balances': null })
    );
    expect(Object.keys(poll.results).sort()).toEqual([
      'customer-balances',
      'settings',
      'sku-private',
    ]);
    expect(poll.role).toBe('owner');
    expect(poll.server_time).toMatch(/\.\d{6}Z$/);

    expect(await page.evaluate(() => window.__jv.client.getConnectionStatus())).toBe('ok');
    expect(await page.evaluate(() => window.__jv.unauthorized)).toBe(0);

    // the headers a function carries (X-JV-Client, Idempotency-Key, Content-Type) get through the API's CORS preflight; X6 is not built yet
    // (404, or 422 once it is), but the answer is the API's own, not a blocked request
    const preflight = refused(await call(page, 'post', '/v1/customers', {}, { idempotent: true }));
    expect(preflight.code).not.toBe('NETWORK');
    expect([404, 422]).toContain(preflight.status);
    expect(preflight.requestId).toEqual(expect.any(String));

    ok(await call(page, 'logout'));
  });

  test('maps a wrong password, an invalid input and a 401 through the client, and runs the 401 hook only for the 401', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await openClient(page);

    // a wrong password is a 401 that is the login screen's own answer: no hook
    const bad = refused(await call(page, 'login', owner.email, `${owner.password}-wrong`));
    expect(bad).toMatchObject({
      code: 'JV_BAD_LOGIN',
      status: 401,
      message: 'Wrong email or password.',
    });
    expect(bad.requestId).toEqual(expect.any(String));
    expect(await page.evaluate(() => window.__jv.unauthorized)).toBe(0);

    ok(await call(page, 'login', owner.email, owner.password));

    // a wrong CURRENT password is a refused input (422), never a 401: the person only mistyped
    const invalid = refused(
      await call(page, 'changePassword', `${owner.password}-wrong`, `${crypto.randomUUID()}-Aa1!`)
    );
    expect(invalid).toMatchObject({
      code: 'JV_INVALID_INPUT',
      status: 422,
      details: { field: 'current_password' },
      nothingChanged: true,
      unconfirmed: false,
    });
    expect(invalid.message).toMatch(/ Nothing was changed\.$/);
    expect(invalid.message).not.toContain(owner.password);
    expect(await page.evaluate(() => window.__jv.unauthorized)).toBe(0);
    // ... and the session is still alive
    ok(await call(page, 'me'));

    // after the logout the cookie is no longer a login: a 401 through the client, and the hook runs once
    ok(await call(page, 'logout'));
    const gone = refused(await call(page, 'me'));
    expect(gone.status).toBe(401);
    expect(['JV_UNAUTHENTICATED', 'JV_SESSION_EXPIRED']).toContain(gone.code);
    expect(gone.nothingChanged).toBe(true);
    expect(await page.evaluate(() => window.__jv.unauthorized)).toBe(1);
  });

  test('a role that may not read a resource gets JV_FORBIDDEN for the whole poll, and that is not a 401', async ({
    page,
  }) => {
    const staff = e2eLogin('staff');
    await openClient(page);
    ok(await call(page, 'login', staff.email, staff.password));

    const forbidden = refused(await call(page, 'poll', { settings: null, 'sku-private': null }));
    expect(forbidden).toMatchObject({
      code: 'JV_FORBIDDEN',
      status: 403,
      message: 'You are not allowed to do this.',
    });
    expect(await page.evaluate(() => window.__jv.unauthorized)).toBe(0);

    // the same staff user may poll what the matrix gives them, and `me` says who they are
    const allowed = ok<{ role: string }>(await call(page, 'poll', { settings: null }));
    expect(allowed.role).toBe('staff');
    const me = ok<{ user: { role: string } }>(await call(page, 'me'));
    expect(me.user.role).toBe('staff');
    ok(await call(page, 'logout'));
  });
});
