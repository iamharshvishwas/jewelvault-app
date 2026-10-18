import { expect, test, type Page } from '@playwright/test';
import { e2eLane, e2eLogin, ROLES } from './global-setup';

// PT-W0 harness smoke (task WEB00): a lane MariaDB and the built API start, the admin door makes users, and a Playwright
// page logs in against it.
//
// The site is not yet built on the API (WEB01 writes the client, WEB02 the login screen), so the page here does what the
// client will do: a `fetch` from a page of the site to the lane's API, with `credentials: 'include'`, the header
// `X-JV-Client: web` and the site's origin. That proves, in a real browser, the three things every later test depends on:
// the lane's API accepts the site's origin (CORS and CSRF layers), the `__Host-jv_session` cookie (Secure, HttpOnly,
// SameSite=Strict) is kept by Chromium on http://localhost and sent back, and the users the harness made can sign in.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/harness.spec.ts

interface Answer {
  status: number;
  body: { user?: Record<string, unknown>; error?: { code?: string } } | null;
}

/** A call to the lane's API made by the page itself, the way the client of WEB01 will make it. */
async function callFromPage(
  page: Page,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> } = {}
): Promise<Answer> {
  const { apiUrl } = e2eLane();
  return page.evaluate(
    async ({ url, method, body, headers }) => {
      const response = await fetch(url, {
        method,
        credentials: 'include',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
    {
      url: `${apiUrl}${path}`,
      method: options.method ?? 'GET',
      body: options.body,
      headers: options.headers ?? {},
    }
  );
}

const WEB_HEADER = { 'x-jv-client': 'web' };

test.describe('PT-W0 harness smoke: lane MariaDB, built API, admin door, a page that logs in', () => {
  test('the lane is up: the API answers /readyz on the lane port, the site on the lane origin', async ({
    page,
    request,
  }) => {
    const { apiUrl, webOrigin } = e2eLane();
    const ready = await request.get(`${apiUrl}/readyz`);
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toEqual({ ok: true });

    await page.goto('/');
    expect(await page.evaluate(() => window.location.origin)).toBe(webOrigin);
  });

  for (const role of ROLES) {
    test(`a page of the site logs in as the ${role} made through the admin door and reads me`, async ({
      page,
      context,
    }) => {
      const { apiUrl } = e2eLane();
      const login = e2eLogin(role);
      await page.goto('/');

      const signedIn = await callFromPage(page, '/v1/auth/login', {
        method: 'POST',
        body: { email: login.email, password: login.password },
        headers: WEB_HEADER,
      });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body?.user).toMatchObject({
        email: login.email,
        full_name: login.fullName,
        role,
        must_change_password: false,
      });

      // Chromium kept the cookie on http://localhost although it is Secure, and the page cannot read it (HttpOnly).
      const cookies = await context.cookies(apiUrl);
      expect(cookies.map((c) => c.name)).toEqual(['__Host-jv_session']);
      expect(cookies[0]).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
      });
      expect(await page.evaluate(() => document.cookie)).toBe('');

      // ... and sends it back: `me` knows who is calling.
      const me = await callFromPage(page, '/v1/auth/me');
      expect(me.status).toBe(200);
      expect(me.body?.user).toMatchObject({ email: login.email, role });

      // Logging out ends the session: the same cookie is no longer a login.
      const out = await callFromPage(page, '/v1/auth/logout', {
        method: 'POST',
        headers: WEB_HEADER,
      });
      expect(out.status).toBe(200);
      const after = await callFromPage(page, '/v1/auth/me');
      expect(after.status).toBe(401);
    });
  }

  test('negative control: a wrong password is refused and leaves no cookie', async ({
    page,
    context,
  }) => {
    const { apiUrl } = e2eLane();
    const login = e2eLogin('owner');
    await page.goto('/');
    const refused = await callFromPage(page, '/v1/auth/login', {
      method: 'POST',
      body: { email: login.email, password: `${login.password}-wrong` },
      headers: WEB_HEADER,
    });
    expect(refused.status).toBe(401);
    expect(refused.body?.error?.code).toBe('JV_BAD_LOGIN');
    expect(await context.cookies(apiUrl)).toEqual([]);
    expect((await callFromPage(page, '/v1/auth/me')).status).toBe(401);
  });
});
