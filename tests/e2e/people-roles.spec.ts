import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { TICK_KEYS, TICK_LABELS } from '../../src/lib/access';
import type { SuperRole, SuperTicksResponse } from '../../src/lib/api/types';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// People & Roles (access and roles, Task 26 part 1; DESIGN 6.5; the screen is Tasks 22 to 25), in a real browser against the real API of a lane. Each test signs in through the real login
// screen with the lane's logins: the Super Admin is the fourth login of the lane (`npm run admin -- make-super-admin`, tests/e2e/README.md).
//
//   1  the menu: the Super Admin sees People & Roles and opens it; Owner, Biller and Staff do not see it, and the address gives them the closed-screen card with a way back to the dashboard
//   2  Copy Biller as "Cashier", then Edit: needs are on and greyed, the "I understand" box, a wrong password saves nothing, the right one saves
//   3  the words of the 32 ticks of the website (`TICK_LABELS`) are the words of GET /v1/super/ticks, key by key; the shape of that answer is what the Edit role screen is written against
//   4  a stale save: the same role open in two browsers, the second saves, the first is told so and Reload starts again from what is saved
//   5  a stale Switch off on the Roles tab (Task 24b): the second browser renames the role, the first presses Switch off on the old row; the password step closes, a notice says the list is
//      up to date, the row shows the new name, and a second Switch off works
//
// THE PASSWORD. The Super Admin's own password asks for itself again on every write (R9). It comes from `process.env` (through `e2eLogin`) and is typed into the field by the keyboard: Playwright
// writes the text of `fill` and `type` into the log of a failed action, the keyboard it does not (`typeSecret`). A test never prints it, never compares it and never puts it in a title.
//
// THE DATA. Roles are never deleted (S7), so what a test makes stays in the lane until the lane is taken down: each test names its own role. "Cashier" (test 2) is the role the later tests of
// this file give to a person.
//
// Run: E2E=1 LANE=c JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/people-roles.spec.ts

const WRONG_PASSWORD_WORDS = 'Your password is not correct.';
const STALE_WORDS = 'This role was changed by someone else. Reload it and try again.';
const LIST_STALE_WORDS =
  'This was changed by someone else. The list is now up to date. Try again if you still want to.';
const TIME_TO_SIGN_IN = 60_000;

const aside = (page: Page) => page.locator('aside');

// ------------------------------------------------------------------------------------------------ the screen

/**
 * Types a password into a field without Playwright writing it into a log: `fill` and `type` put their text in the call log of an action that fails, the keyboard does not. The field is clicked
 * first, so that the keys go to it. Nothing asserts on the value either (a failed assertion prints what it received).
 */
async function typeSecret(page: Page, field: Locator, secret: string): Promise<void> {
  await field.click();
  await page.keyboard.type(secret);
}

/** Signs in through the login screen and waits until the application is on screen (the sidebar names the person). */
async function signInAs(page: Page, who: E2eLogin): Promise<void> {
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await typeSecret(page, page.getByLabel('Password'), who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: TIME_TO_SIGN_IN });
}

/** The sidebar's "People & Roles", pressed; waits until the three lists have loaded and the tabs are there. */
async function openPeopleAndRoles(page: Page): Promise<void> {
  await aside(page).getByRole('link', { name: 'People & Roles' }).click();
  await expect(page).toHaveURL(/\/people-roles\/?$/);
  await expect(page.getByRole('heading', { level: 1, name: 'People & Roles' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'People and roles' })).toBeVisible();
}

async function openRolesTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Roles' }).click();
  await expect(page.getByTestId('roles-tab')).toBeVisible();
}

/** The row of a role in the Roles tab, found by its name. */
const roleRow = (page: Page, name: string): Locator =>
  page.getByTestId('role-row').filter({ has: page.getByText(name, { exact: true }) });

/** The password step is on screen: types the Super Admin's password and presses its button (Confirm and ...). */
async function confirmWithPassword(page: Page, password: string): Promise<void> {
  const step = page.getByTestId('confirm-password-dialog');
  await typeSecret(page, step.getByTestId('confirm-password-input'), password);
  await step.getByTestId('confirm-password-confirm').click();
}

/** The role of an answer of the API, as `/v1/super/roles` lists it: what a screen shows is checked against this. */
async function rolesFromApi(page: Page): Promise<SuperRole[]> {
  const { apiUrl } = e2eLane();
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/v1/super/roles`, { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  }, apiUrl);
  expect(answer.status, 'GET /v1/super/roles').toBe(200);
  return (answer.body as { roles: SuperRole[] }).roles;
}

async function roleFromApi(page: Page, name: string): Promise<SuperRole> {
  const role = (await rolesFromApi(page)).find((one) => one.name === name);
  if (!role) throw new Error(`the API lists no role called ${name}`);
  return role;
}

/**
 * Roles tab: Copy on the row of `from`, the New role form, the password step. Waits until the new role is in the list. Answers with what the API said to the create (a 201 and `{ role }`).
 */
async function copyRole(
  page: Page,
  options: { from: string; name: string; description?: string; password: string }
): Promise<{ status: number; body: { role: SuperRole } }> {
  await page.getByRole('button', { name: `Copy ${options.from}`, exact: true }).click();
  const form = page.getByTestId('new-role-dialog');
  await expect(form).toBeVisible();
  // the role of the row is the one to start from (the choices are numbered by place: the name is what is read)
  await expect(form.getByTestId('new-role-from').locator('option:checked')).toHaveText(
    options.from
  );
  await form.getByTestId('new-role-name').fill(options.name);
  if (options.description !== undefined)
    await form.getByTestId('new-role-description').fill(options.description);
  await form.getByTestId('new-role-continue').click();

  const step = page.getByTestId('confirm-password-dialog');
  await expect(step).toBeVisible();
  await expect(step).toContainText(
    `Create the role ${options.name}, starting from ${options.from}`
  );
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/super/roles' &&
      response.request().method() === 'POST'
  );
  await confirmWithPassword(page, options.password);
  const response = await created;
  await expect(step).toHaveCount(0);
  await expect(roleRow(page, options.name)).toBeVisible();
  return { status: response.status(), body: (await response.json()) as { role: SuperRole } };
}

/** One tick of the Edit role screen, by its words (the start of its name: "Changed" and "Sensitive" are marks after the words). */
const tickBox = (page: Page, words: string): Locator =>
  page.getByRole('checkbox', {
    name: new RegExp(`^${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });

/**
 * Presses the row of a tick, as a thumb does: the whole row is the button, and its box is a check box that only the keyboard and a screen reader reach (it is hidden from the eye and lies
 * under the row), so the pointer goes to the row's label and the browser passes the press on to the box.
 */
async function toggleTick(page: Page, words: string): Promise<void> {
  await tickBox(page, words).locator('xpath=..').click();
}

/** Orders tick keys as the catalogue does (a role lists its ticks in catalogue order). */
const byCatalogue = (a: string, b: string): number =>
  TICK_KEYS.indexOf(a as (typeof TICK_KEYS)[number]) -
  TICK_KEYS.indexOf(b as (typeof TICK_KEYS)[number]);

/** Another browser of the same person: a context of its own has its own cookie, so its own session. */
async function otherBrowser(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

// A sign-in hydrates the whole cache and the first visit of a page makes the dev server compile it: the default 30 seconds are too few for a test of several steps.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});

// ------------------------------------------------------------------------------------------------ 1: the menu

test.describe('who sees People & Roles', () => {
  const LABELS = { owner: 'Owner', biller: 'Biller', staff: 'Staff' } as const;

  test('the Super Admin sees People & Roles and opens it; Owner, Biller and Staff do not see it, and /people-roles for them is the closed-screen card with a way back to the dashboard', async ({
    page,
    browser,
  }) => {
    const superAdmin = e2eLogin('super');
    const { apiUrl } = e2eLane();

    await test.step('the Super Admin: the menu offers it, and it opens on the People tab', async () => {
      await signInAs(page, superAdmin);
      await expect(aside(page).getByTestId('session-role')).toHaveText('Super Admin');
      // the lane made her with `make-super-admin`: the role Owner and the flag, and an e-mail of her own
      const me = await page.evaluate(async (url) => {
        const response = await fetch(`${url}/v1/auth/me`, { credentials: 'include' });
        return (await response.json()) as {
          user: { email: string; role: string; is_super_admin: boolean; permissions: string[] };
        };
      }, apiUrl);
      expect(me.user.role).toBe('owner');
      expect(me.user.is_super_admin).toBe(true);
      expect(me.user.permissions).toHaveLength(32);
      expect(me.user.email).toBe(superAdmin.email);
      expect(me.user.email).not.toBe(e2eLogin('owner').email);

      await openPeopleAndRoles(page);
      await expect(page.getByRole('tab', { name: 'People' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      // the four logins of the lane, each with its role; hers carries the pill and the line that says what she may do to her own row
      const rows = page.getByTestId('person-row');
      await expect(rows).toHaveCount(4);
      for (const [login, pill] of [
        ['owner', 'Owner'],
        ['biller', 'Biller'],
        ['staff', 'Staff'],
        ['super', 'Super Admin'],
      ] as const) {
        await expect(rows.filter({ hasText: e2eLogin(login).email })).toContainText(pill);
      }
      const own = rows.filter({ hasText: superAdmin.email });
      await expect(own.getByTestId('person-lock-line')).toHaveText(
        'This is you. Only your name and e-mail can be changed here.'
      );
      await expect(own.getByRole('button')).toHaveCount(1);
      await expect(own.getByTestId('person-edit')).toBeVisible();
    });

    for (const role of ['owner', 'biller', 'staff'] as const) {
      await test.step(`the ${role}: no menu item, and the address gives the closed-screen card`, async () => {
        const other = await otherBrowser(browser);
        const superCalls: string[] = [];
        other.page.on('request', (request) => {
          if (new URL(request.url()).pathname.startsWith('/v1/super/'))
            superCalls.push(request.url());
        });
        try {
          await signInAs(other.page, e2eLogin(role));
          await expect(aside(other.page).getByTestId('session-role')).toHaveText(LABELS[role]);
          await expect(aside(other.page).getByRole('link', { name: 'People & Roles' })).toHaveCount(
            0
          );
          await expect(other.page.locator('a[href="/people-roles"]')).toHaveCount(0);

          await other.page.goto('/people-roles');
          await expect(
            other.page.getByRole('heading', { level: 1, name: 'Not available for your role' })
          ).toBeVisible();
          await expect(other.page.getByRole('heading', { name: 'People & Roles' })).toHaveCount(0);
          await expect(other.page.getByRole('tablist')).toHaveCount(0);
          // the way back leads to the dashboard
          await other.page.getByRole('link', { name: 'Go to Dashboard' }).click();
          await expect(other.page).toHaveURL(/\/$/);
          await expect(other.page.getByText('Not available for your role')).toHaveCount(0);
          await expect(other.page.getByRole('heading', { level: 1 })).toBeVisible();
          // nothing of the screen was asked for: the three reads are the Super Admin's alone
          expect(superCalls, 'calls of /v1/super made by this page').toEqual([]);
        } finally {
          await other.close();
        }
      });
    }
  });
});

// ------------------------------------------------------------------------------------------------ 2: copy Biller as Cashier

test.describe('a new role from the Biller', () => {
  test('copy Biller as "Cashier", turn on "See the cash book for all days" (its needed tick is on and greyed) and "Cancel a bill" (the I understand box appears), save: a wrong password gives a plain message and saves nothing, the right one saves', async ({
    page,
  }) => {
    const superAdmin = e2eLogin('super');
    await signInAs(page, superAdmin);
    await openPeopleAndRoles(page);
    await openRolesTab(page);

    // Roles tab: Copy on the Biller row, the New role form, the password step
    const biller = await roleFromApi(page, 'Biller');
    expect(biller.ticks, 'the nine ticks of the Biller').toHaveLength(9);
    const created = await copyRole(page, {
      from: 'Biller',
      name: 'Cashier',
      description: 'Makes bills at the counter.',
      password: superAdmin.password,
    });
    expect(created.status, 'a create answers 201').toBe(201);
    expect(Object.keys(created.body), 'and only { role }').toEqual(['role']);
    expect(created.body.role).toMatchObject({
      name: 'Cashier',
      description: 'Makes bills at the counter.',
      active: true,
      fixed: false,
      people: 0,
    });
    // the copy holds the Biller's nine, which are closed by needs already: nothing is added
    expect(created.body.role.ticks).toEqual(biller.ticks);
    await expect(roleRow(page, 'Cashier')).toContainText('9 of 32 ticks');
    await expect(roleRow(page, 'Cashier')).toContainText('0 people');

    // Edit on the new role: the editor
    await page.getByRole('button', { name: 'Edit Cashier', exact: true }).click();
    const editor = page.getByTestId('edit-role');
    await expect(editor.getByRole('heading', { level: 2, name: 'Edit role' })).toBeVisible();
    await expect(page.getByTestId('edit-role-name')).toHaveValue('Cashier');
    await expect(page.getByTestId('edit-role-people')).toHaveText('Nobody has this role yet.');
    // the editor draws Save twice (the heading and the phone bar): only the one of the heading is on a desktop screen
    const save = page.getByTestId('edit-role-head-save');
    await expect(save).toBeVisible();
    await expect(save).toBeDisabled(); // nothing has been changed yet
    await expect(page.getByTestId('edit-role-phone-save')).toBeHidden();

    // "See the cash book for all days" needs "See the cash book for today and yesterday", which the Biller has: it is on, and it is greyed from now on
    const recent = tickBox(page, 'See the cash book for today and yesterday');
    await expect(recent).toBeChecked();
    await expect(recent).toBeEnabled();
    await toggleTick(page, 'See the cash book for all days');
    await expect(tickBox(page, 'See the cash book for all days')).toBeChecked();
    await expect(recent).toBeChecked();
    await expect(recent).toBeDisabled();
    await expect(recent).toHaveAccessibleDescription(/Needed by “See the cash book for all days”/);
    // it is not sensitive: no box yet, and Save is ready
    await expect(page.getByTestId('edit-role-understand')).toHaveCount(0);
    await expect(save).toBeEnabled();

    // "Cancel a bill" is sensitive: the "I understand" box appears and Save waits for it
    await toggleTick(page, 'Cancel a bill');
    const understand = page.getByTestId('edit-role-understand');
    await expect(understand).toBeVisible();
    await expect(understand).toContainText('I understand: people with this role will be able to:');
    await expect(understand.getByRole('listitem')).toHaveText(['Cancel a bill']);
    await expect(save).toBeDisabled();
    await expect(page.getByText('Tick “I understand” first.').first()).toBeVisible();
    await expect(page.getByTestId('edit-role-banner')).toContainText(
      '2 changes not saved yet: See the cash book for all days, Cancel a bill'
    );
    await understand.getByTestId('edit-role-understand-box').check();
    await expect(save).toBeEnabled();

    // Save: the password step says what is about to happen
    await save.click();
    const step = page.getByTestId('confirm-password-dialog');
    await expect(step).toBeVisible();
    await expect(step.getByRole('heading', { name: 'Save changes to “Cashier”?' })).toBeVisible();
    const summary = step.getByTestId('edit-role-summary');
    await expect(summary).toContainText('Turning on');
    await expect(summary).toContainText('See the cash book for all days');
    await expect(summary).toContainText('Cancel a bill');
    await expect(summary).toContainText('Turning off');

    // a wrong password: a plain message, the step stays open, and nothing was saved (the list the API gives is the list it had)
    const before = await roleFromApi(page, 'Cashier');
    await confirmWithPassword(page, 'this-is-not-the-password');
    await expect(step.getByTestId('confirm-password-error')).toHaveText(WRONG_PASSWORD_WORDS);
    await expect(step).toBeVisible();
    expect(await roleFromApi(page, 'Cashier'), 'the role after a wrong password').toEqual(before);
    await expect(page.getByTestId('edit-role-saved')).toHaveCount(0);

    // the right one saves
    await confirmWithPassword(page, superAdmin.password);
    await expect(step).toHaveCount(0);
    await expect(page.getByTestId('edit-role-saved')).toHaveText('Saved.');
    await expect(page.getByTestId('edit-role-banner')).toHaveCount(0);
    await expect(save).toBeDisabled(); // what is on screen is what is saved
    const after = await roleFromApi(page, 'Cashier');
    expect(after.ticks).toEqual([...before.ticks, 'cashbook_all', 'bill_cancel'].sort(byCatalogue));
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(after.name).toBe('Cashier');

    // back in the list: the row says so
    await page.getByTestId('edit-role-back').click();
    await expect(roleRow(page, 'Cashier')).toContainText('11 of 32 ticks');
  });
});

// ------------------------------------------------------------------------------------------------ 3: the words of the ticks

test.describe('the catalogue of ticks', () => {
  /** GET /v1/super/ticks the way the app asks it: from a page of the site, with the Super Admin's session. */
  async function catalogueFromApi(page: Page): Promise<SuperTicksResponse> {
    const { apiUrl } = e2eLane();
    await signInAs(page, e2eLogin('super'));
    const answer = await page.evaluate(async (url) => {
      const response = await fetch(`${url}/v1/super/ticks`, { credentials: 'include' });
      return { status: response.status, body: await response.json() };
    }, apiUrl);
    expect(answer.status, 'GET /v1/super/ticks').toBe(200);
    return answer.body as SuperTicksResponse;
  }

  test("the website's TICK_LABELS equal the words of GET /v1/super/ticks, key by key", async ({
    page,
  }) => {
    const catalogue = await catalogueFromApi(page);
    // the same 32 keys, in the same order
    expect(catalogue.ticks.map((tick) => tick.key)).toEqual([...TICK_KEYS]);
    // the words, key by key: a difference names the key and both texts
    const differing = catalogue.ticks
      .filter((tick) => tick.label !== TICK_LABELS[tick.key])
      .map((tick) => ({ key: tick.key, website: TICK_LABELS[tick.key], api: tick.label }));
    expect(differing, 'ticks whose words differ (website against API)').toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ 4: a stale save

test.describe('a role changed in another browser', () => {
  test('the same role open in two browsers: the second saves a rename, an emptied description and a tick; the first is told that someone else changed it, nothing of the second is undone, and Reload starts again from what is saved', async ({
    page,
    browser,
  }) => {
    const superAdmin = e2eLogin('super');
    const NAME = 'Stale probe';
    const RENAMED = 'Stale probe renamed';

    // the role: a copy of the Staff role with a description (the second browser empties it)
    await signInAs(page, superAdmin);
    await openPeopleAndRoles(page);
    await openRolesTab(page);
    await copyRole(page, {
      from: 'Staff',
      name: NAME,
      description: 'Only for the stale save test.',
      password: superAdmin.password,
    });

    // the first browser opens the editor and changes nothing yet
    await page.getByRole('button', { name: `Edit ${NAME}`, exact: true }).click();
    await expect(page.getByTestId('edit-role-name')).toHaveValue(NAME);
    const staleStamp = (await roleFromApi(page, NAME)).updated_at;

    // the second browser (its own session) saves: rename, description emptied, "Open Reports" on. That is two writes in one save: the name and the description first, then the ticks, which
    // name the stamp the first write answered with
    const second = await otherBrowser(browser);
    try {
      await signInAs(second.page, superAdmin);
      await openPeopleAndRoles(second.page);
      await openRolesTab(second.page);
      await second.page.getByRole('button', { name: `Edit ${NAME}`, exact: true }).click();
      await expect(second.page.getByTestId('edit-role-name')).toHaveValue(NAME);
      await second.page.getByTestId('edit-role-name').fill(RENAMED);
      await second.page.getByTestId('edit-role-description').fill('');
      await toggleTick(second.page, 'Open Reports');
      await second.page.getByTestId('edit-role-head-save').click();
      await confirmWithPassword(second.page, superAdmin.password);
      await expect(second.page.getByTestId('edit-role-saved')).toHaveText('Saved.');
      await expect(second.page.getByTestId('edit-role-problem')).toHaveCount(0);
    } finally {
      await second.close();
    }
    const saved = await roleFromApi(page, RENAMED);
    expect(saved.description, 'an emptied description is accepted').toBe('');
    expect(saved.ticks).toContain('reports_open');
    expect(saved.updated_at).not.toBe(staleStamp);

    // back in the first browser, which still holds the old copy: a tick change is refused as stale, in the words of the screen, with a Reload button
    await toggleTick(page, 'See the cash book for today and yesterday');
    await expect(tickBox(page, 'See the cash book for today and yesterday')).toBeChecked();
    await page.getByTestId('edit-role-head-save').click();
    await confirmWithPassword(page, superAdmin.password);
    const stale = page.getByTestId('edit-role-stale');
    await expect(stale).toBeVisible();
    await expect(stale.locator('p')).toHaveText(STALE_WORDS);
    await expect(stale.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
    await expect(page.getByTestId('confirm-password-dialog')).toHaveCount(0);
    // her edit stays on screen until she presses Reload, and nothing of hers was written
    await expect(tickBox(page, 'See the cash book for today and yesterday')).toBeChecked();
    const now = await roleFromApi(page, RENAMED);
    expect(now).toEqual(saved);
    expect(now.ticks).not.toContain('cashbook_recent');
    expect(await rolesFromApi(page)).not.toContainEqual(expect.objectContaining({ name: NAME }));

    // Reload: the editor starts again from the role as it is saved now
    await stale.getByRole('button', { name: 'Reload', exact: true }).click();
    await expect(page.getByTestId('edit-role-stale')).toHaveCount(0);
    await expect(page.getByTestId('edit-role-name')).toHaveValue(RENAMED);
    await expect(page.getByTestId('edit-role-description')).toHaveValue('');
    await expect(tickBox(page, 'Open Reports')).toBeChecked();
    await expect(tickBox(page, 'See the cash book for today and yesterday')).not.toBeChecked();
    await expect(page.getByTestId('edit-role-banner')).toHaveCount(0);
    await expect(page.getByTestId('edit-role-head-save')).toBeDisabled();
  });
});

// ------------------------------------------------------------------------------------------------ 5: a stale Switch off on the Roles tab

test.describe('a role renamed in another browser while a Switch off is asked for on its old row', () => {
  test('the same role on the Roles tab in two browsers: the second renames it, the first presses Switch off on the OLD row and confirms: the password step closes, a notice says the list is up to date, the row shows the new name, and a second Switch off on the refreshed row works', async ({
    page,
    browser,
  }) => {
    const superAdmin = e2eLogin('super');
    const NAME = 'Switch probe';
    const RENAMED = 'Switch probe renamed';

    // the role: a copy of the Staff role, which nobody holds (a role that people hold cannot be switched off)
    await signInAs(page, superAdmin);
    await openPeopleAndRoles(page);
    await openRolesTab(page);
    await copyRole(page, { from: 'Staff', name: NAME, password: superAdmin.password });
    const before = await roleFromApi(page, NAME);
    expect(before.people, 'nobody holds the new role').toBe(0);
    expect(before.active).toBe(true);

    // the second browser (its own session) renames it on the Edit role screen: the role gets a new stamp, and the first browser's row, which nothing re-reads, is old
    const second = await otherBrowser(browser);
    try {
      await signInAs(second.page, superAdmin);
      await openPeopleAndRoles(second.page);
      await openRolesTab(second.page);
      await second.page.getByRole('button', { name: `Edit ${NAME}`, exact: true }).click();
      await expect(second.page.getByTestId('edit-role-name')).toHaveValue(NAME);
      await second.page.getByTestId('edit-role-name').fill(RENAMED);
      await second.page.getByTestId('edit-role-head-save').click();
      await confirmWithPassword(second.page, superAdmin.password);
      await expect(second.page.getByTestId('edit-role-saved')).toHaveText('Saved.');
    } finally {
      await second.close();
    }
    const renamed = await roleFromApi(page, RENAMED);
    expect(renamed.updated_at, 'the rename gave the role a new stamp').not.toBe(before.updated_at);
    expect(renamed.active).toBe(true);

    // the first browser still shows the OLD row; Switch off on it, and the right password
    await expect(roleRow(page, NAME)).toBeVisible();
    await expect(roleRow(page, RENAMED)).toHaveCount(0);
    await page.getByRole('button', { name: `Switch off ${NAME}`, exact: true }).click();
    const step = page.getByTestId('confirm-password-dialog');
    await expect(step).toContainText(`Switch off the role ${NAME}`);
    await confirmWithPassword(page, superAdmin.password);

    // the API refused it as stale: the password step closes (a second try on it could only be refused again), and a notice above the list says what happened
    await expect(step).toHaveCount(0);
    const notice = page.getByTestId('roles-stale-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('role', 'alert');
    await expect(notice.locator('p')).toHaveText(LIST_STALE_WORDS);
    await expect(notice.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
    // the lists were read again: the row behind the notice is the role as it is now, under its new name
    await expect(roleRow(page, RENAMED)).toBeVisible();
    await expect(roleRow(page, NAME)).toHaveCount(0);
    await expect(roleRow(page, RENAMED)).not.toContainText('Switched off');
    // the refused attempt wrote nothing
    expect((await roleFromApi(page, RENAMED)).active, 'still switched on').toBe(true);

    // a second Switch off, on the refreshed row, works. Opening its step puts the notice away
    await page.getByRole('button', { name: `Switch off ${RENAMED}`, exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(step).toContainText(`Switch off the role ${RENAMED}`);
    await confirmWithPassword(page, superAdmin.password);
    await expect(step).toHaveCount(0);
    await expect(roleRow(page, RENAMED)).toContainText('Switched off');
    await expect(
      page.getByRole('button', { name: `Switch on ${RENAMED}`, exact: true })
    ).toBeVisible();
    await expect(notice).toHaveCount(0);
    const after = await roleFromApi(page, RENAMED);
    expect(after.active, 'the second Switch off went through').toBe(false);
    expect(after.updated_at).not.toBe(renamed.updated_at);
  });
});
