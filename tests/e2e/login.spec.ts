import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { connect } from '../db/pg';
import { apiEnv, createLogin, deleteLogin, type AppRole } from '../db/rpc';
import { e2eLogin, ROLES } from './global-setup';

// FE02. T-E01 (login per role; a wrong password fails; an inactive login; 20 login and logout cycles; the owner sees the
// rate card right after login), T-E08 (12 hours without a click or key press, with a faked clock) and the browser half of
// T-D06 (updateUser with a role has no effect).
// Not here: "a user deactivated while signed in is logged out at the next poll" (C18). The poll is written in FE04, which
// adds that case to T-E01. The same goes for hydrating data behind the loading gate (FE03).
//
// The logins come from tests/e2e/global-setup.ts (the local Auth admin API). Run: LANE=b npm run test:e2e

const aside = (page: Page) => page.locator('aside');
const ROLE_LABEL: Record<AppRole, string> = { owner: 'Owner', biller: 'Biller', staff: 'Staff' };

async function openLoginScreen(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
}

async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in through the screen and waits until the application is on screen. */
async function signInAs(page: Page, kind: AppRole) {
  const login = e2eLogin(kind);
  await openLoginScreen(page);
  await submitLogin(page, login.email, login.password);
  await expect(aside(page)).toContainText(login.fullName);
}

async function logout(page: Page) {
  await aside(page).getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
}

/** The library takes the session out of the browser a moment after the screen has gone to the login (it ends it on the server first). */
async function expectNoSession(page: Page) {
  await expect.poll(() => sessionKeys(page)).toEqual([]);
}

/** The keys the Supabase library keeps the session under (C8: the only thing the browser may keep). */
async function sessionKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith('sb-'))
  );
}

test.describe('T-E01: the login screen', () => {
  test('shows no credentials, no hints and an empty form (U1)', async ({ page }) => {
    await openLoginScreen(page);
    await expect(page.getByLabel('Email')).toHaveValue('');
    await expect(page.getByLabel('Password')).toHaveValue('');
    const text = (await page.locator('body').innerText()).toLowerCase();
    // The prototype's two passwords, written in two pieces so that a search of the repository for them finds nothing.
    const oldPasswords = ['admin' + '123', 'staff' + '123'];
    for (const forbidden of [...oldPasswords, 'admin /', 'staff /', 'local staff access']) {
      expect(text).not.toContain(forbidden);
    }
    expect(await page.content()).not.toContain(oldPasswords[0]);
  });

  test('a wrong password fails, with one message that does not say which part was wrong', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await openLoginScreen(page);
    await submitLogin(page, owner.email, 'not-the-password-1');
    await expect(page.getByText('Wrong email or password')).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    await expectNoSession(page);

    await submitLogin(page, 'nobody-here@jv-test.local', 'not-the-password-1');
    await expect(page.getByText('Wrong email or password')).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
  });

  test('an inactive login sees "Your account is not active" and holds no session (A10, U3)', async ({
    page,
  }) => {
    const inactive = e2eLogin('inactive');
    await openLoginScreen(page);
    await submitLogin(page, inactive.email, inactive.password);
    await expect(page.getByText('Your account is not active')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    await expect.poll(() => sessionKeys(page)).toEqual([]);
  });
});

test.describe('T-E01: a login per role, and the menus of the role (U5)', () => {
  // [role, links the menu must offer, links it must not]
  const MENUS: Array<[AppRole, string[], string[]]> = [
    ['owner', ['Reports', 'Add Design', 'New Estimate', 'Customers & Ledger'], ['Order Book']],
    [
      'biller',
      ['New Estimate', 'Customers & Ledger', 'Stock List'],
      ['Reports', 'Add Design', 'Edit Stock', 'Order Book'],
    ],
    [
      'staff',
      ['Add Design', 'Edit Stock', 'Stock List'],
      ['Reports', 'New Estimate', 'Customers & Ledger', 'Order Book'],
    ],
  ];

  for (const [role, offered, hidden] of MENUS) {
    test(`the ${role} signs in and gets the ${role}'s menu`, async ({ page }) => {
      await signInAs(page, role);
      await expect(aside(page).getByTestId('session-role')).toHaveText(ROLE_LABEL[role]);
      // expand every group so that each link is in the page
      for (const group of ['Inventory', 'Sales', 'Customers', 'Stock', 'Settings']) {
        const button = aside(page).getByRole('button', { name: group, exact: true });
        if ((await button.count()) && (await button.getAttribute('aria-expanded')) === 'false') {
          await button.click();
        }
      }
      for (const label of offered) {
        await expect(aside(page).getByRole('link', { name: label }).first()).toBeAttached();
      }
      for (const label of hidden) {
        await expect(aside(page).getByRole('link', { name: label })).toHaveCount(0);
      }
      await logout(page);
    });
  }

  test('a screen outside the role says so, and the dashboard stays reachable', async ({ page }) => {
    await signInAs(page, 'staff');
    await page.goto('/reports');
    await expect(page.getByText('Not available for your role')).toBeVisible();
    await page.getByRole('link', { name: 'Go to Dashboard' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/billing-pos');
    await expect(page.getByText('Not available for your role')).toBeVisible();
    await page.goto('/add-design');
    await expect(page.getByText('Not available for your role')).toHaveCount(0);
  });

  test('the session survives a reload, and logout takes it away (U8, C8)', async ({ page }) => {
    await signInAs(page, 'biller');
    expect((await sessionKeys(page)).length).toBeGreaterThan(0);
    await page.reload();
    await expect(aside(page)).toContainText('Test biller');
    await logout(page);
    await expectNoSession(page);
    await page.reload();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
  });
});

test.describe('T-E01: the dashboard at login (U7)', () => {
  test('the owner sees the rate card right after login, with no reload', async ({ page }) => {
    await signInAs(page, 'owner');
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toBeVisible();
    await logout(page);
  });

  test('the biller and the staff do not get the owner-only blocks', async ({ page }) => {
    await signInAs(page, 'biller');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toHaveCount(0);
    await logout(page);
    await signInAs(page, 'staff');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toHaveCount(0);
  });
});

test.describe('T-E01: 20 login and logout cycles (U6)', () => {
  test('never hang', async ({ page }) => {
    test.setTimeout(240_000);
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
    });
    await openLoginScreen(page);
    for (let cycle = 0; cycle < 20; cycle++) {
      const role = ROLES[cycle % ROLES.length];
      const login = e2eLogin(role);
      await submitLogin(page, login.email, login.password);
      await expect(aside(page), `cycle ${cycle + 1}: sign in as ${role}`).toContainText(
        login.fullName
      );
      await logout(page);
      await expect(page.getByLabel('Email'), `cycle ${cycle + 1}: logged out`).toHaveValue('');
    }
    await expectNoSession(page);
    expect(problems, 'nothing was reported to the console in 20 cycles').toEqual([]);
  });
});

test.describe('T-D06 (browser half): the role comes from the profile, never from the login metadata', () => {
  test('updateUser({ data: { role: "owner" } }) changes what the token says and nothing the screen shows', async ({
    page,
  }) => {
    const staff = await createLogin({ appRole: 'staff' });
    const db = await connect('e2e-profile-check');
    try {
      // The user changes their own metadata, exactly as the browser client could.
      const { apiUrl, publishableKey } = apiEnv();
      const client = createClient(apiUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const signedIn = await client.auth.signInWithPassword({
        email: staff.email,
        password: staff.password,
      });
      expect(signedIn.error).toBeNull();
      const updated = await client.auth.updateUser({ data: { role: 'owner' } });
      expect(updated.error).toBeNull();
      expect(updated.data.user?.user_metadata?.role, 'the metadata did change').toBe('owner');

      // A fresh login now carries role: owner in its metadata. The screen must still show a staff member.
      await openLoginScreen(page);
      await submitLogin(page, staff.email, staff.password);
      await expect(aside(page)).toContainText('Test staff');
      await expect(aside(page).getByRole('link', { name: 'Reports' })).toHaveCount(0);
      await page.goto('/reports');
      await expect(page.getByText('Not available for your role')).toBeVisible();
      await page.goto('/settings');
      await expect(page.getByText('Not available for your role')).toBeVisible();

      const { rows } = await db.query('select role, active from public.profiles where id = $1', [
        staff.id,
      ]);
      expect(rows).toEqual([{ role: 'staff', active: true }]);
    } finally {
      await db.end();
      await deleteLogin(staff.id).catch(() => undefined);
    }
  });
});

test.describe('T-E08: 12 hours without a click or key press (U4, C16), with a faked clock', () => {
  const signedOutNotice = /signed out .*12 hours/i;

  test('the screen logs out by itself, and keeps nothing', async ({ page }) => {
    await page.clock.install();
    await signInAs(page, 'owner');

    await page.clock.fastForward('11:59:00');
    await expect(aside(page), 'still signed in after 11 h 59 min').toBeVisible();

    await page.clock.fastForward('00:02:00');
    await expect(page.getByLabel('Email'), 'logged out after 12 h 01 min').toBeVisible();
    await expect(page.getByText(signedOutNotice)).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    await expectNoSession(page);
  });

  test('a click starts the 12 hours again', async ({ page }) => {
    await page.clock.install();
    await signInAs(page, 'biller');

    await page.clock.fastForward('11:30:00');
    await page.getByRole('heading', { level: 1 }).click();
    await page.clock.fastForward('11:30:00');
    await expect(aside(page), '23 h after login, 11 h 30 min after the click').toBeVisible();

    await page.clock.fastForward('01:00:00');
    await expect(page.getByLabel('Email'), '12 h 30 min after the click').toBeVisible();
    await expect(page.getByText(signedOutNotice)).toBeVisible();
  });

  test('a key press starts the 12 hours again', async ({ page }) => {
    await page.clock.install();
    await signInAs(page, 'staff');

    await page.clock.fastForward('11:30:00');
    await page.keyboard.press('Shift');
    await page.clock.fastForward('11:30:00');
    await expect(aside(page), '11 h 30 min after the key press').toBeVisible();

    await page.clock.fastForward('01:00:00');
    await expect(page.getByLabel('Email'), '12 h 30 min after the key press').toBeVisible();
  });

  test('after the idle logout the same person can sign in again', async ({ page }) => {
    await page.clock.install();
    await signInAs(page, 'owner');
    await page.clock.fastForward('12:05:00');
    await expect(page.getByLabel('Email')).toBeVisible();
    const owner = e2eLogin('owner');
    await submitLogin(page, owner.email, owner.password);
    await expect(aside(page)).toContainText(owner.fullName);
  });
});
