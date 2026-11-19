import { randomBytes } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import { SCREENS, TICK_KEYS, TICK_LABELS } from '../../src/lib/access';
import type {
  MeResponse,
  MeUser,
  SuperPerson,
  SuperRole,
  SuperTicksResponse,
} from '../../src/lib/api/types';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';
import { PHONE, expectNoSidewaysScroll, expectTappable } from './phone';

// People & Roles (access and roles, Task 26 part 1; DESIGN 6.5; the screen is Tasks 22 to 25), in a real browser against the real API of a lane. Each test signs in through the real login
// screen with the lane's logins: the Super Admin is the fourth login of the lane (`npm run admin -- make-super-admin`, tests/e2e/README.md).
//
//   1  the menu: the Super Admin sees People & Roles and opens it; Owner, Biller and Staff do not see it, and the address gives them the closed-screen card with a way back to the dashboard
//   2  Copy Biller as "Cashier", then Edit: needs are on and greyed, the "I understand" box, a wrong password saves nothing, the right one saves
//   3  the words of the 32 ticks of the website (`TICK_LABELS`) are the words of GET /v1/super/ticks, key by key; the shape of that answer is what the Edit role screen is written against
//   4  a stale save: the same role open in two browsers, the second saves, the first is told so and Reload starts again from what is saved
//   5  a stale Switch off on the Roles tab (Task 24b): the second browser renames the role, the first presses Switch off on the old row; the password step closes, a notice says the list is
//      up to date, the row shows the new name, and a second Switch off works
//   (part 2 of Task 26: the people writes of API Task 14 are in the lane's API)
//   6  add a person with a role: the temporary password is shown once and is nowhere in the page afterwards; in a second browser context that person signs in, changes the password and gets
//      the menu of the role
//   7  P6: the Super Admin takes "Make bills and estimates" (and the Order Book) away from a role while its person is signed in: at the next poll the menu loses them, the screen the person
//      is on becomes the closed-screen card, and the next hydrate asks for nothing the person may not read
//   8  P8: a role with no ticks: its person signs in and meets only the screens that everybody has, and no error line anywhere
//   9  a phone, 375 x 812: People as cards, the dialogs, Roles, Edit role with its Save bar, and the page never scrolls sideways
//  10  the Owner's Activity Log tells the Super Admin's changes in words
//
// THE PASSWORD. The Super Admin's own password asks for itself again on every write (R9). It comes from `process.env` (through `e2eLogin`) and is typed into the field by the keyboard: Playwright
// writes the text of `fill` and `type` into the log of a failed action, the keyboard it does not (`typeSecret`). A test never prints it, never compares it and never puts it in a title.
//
// THE DATA. Roles and people are never deleted (S7), so what a test makes stays in the lane until the lane is taken down. The tests of part 1 name their roles by hand ("Cashier", "Stale probe");
// the tests of part 2 add `RUN`, a few letters and digits made when the file is loaded, to every role and person they make, and none of them leans on what another test made (a test run alone
// works). The names of part 1 would clash on a retry (`CI=1` retries twice): a retry is a new load of the file, so the names of part 2 never do.
//
// The temporary password of a new person is shown once, on screen, and a test has to read it from there to type it into the login screen. It is kept in a variable, typed by the keyboard,
// and is never printed, compared or put in a title: a check that needs it is written so that a failure says WHERE it was found (`whereIs`) and not what it was.
//
// Run: E2E=1 LANE=c JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/people-roles.spec.ts

const WRONG_PASSWORD_WORDS = 'Your password is not correct.';
const STALE_WORDS = 'This role was changed by someone else. Reload it and try again.';
const LIST_STALE_WORDS =
  'This was changed by someone else. The list is now up to date. Try again if you still want to.';
const TIME_TO_SIGN_IN = 60_000;

/** The sidebar of the application (a page may have a second `aside`, like the inventory's filters, after it). */
const aside = (page: Page) => page.locator('aside').first();

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

// ------------------------------------------------------------------------------------------------ part 2: people, a person's first sign-in, what a browser asks for

/** Made once when the file is loaded (a retry is a new load): every role and person a test of part 2 makes carries it in its name. */
const RUN = randomBytes(3).toString('hex');

/** A password for a new person: made up here, kept in memory, never printed. Long, with both letter cases, a digit and a dash, and nothing of an e-mail address in it. */
const newPassword = (): string => `${randomBytes(18).toString('base64url')}-Aa1`;

/** A person a test adds. `role` is the NAME of the role: the form offers the roles by their names. */
interface NewPerson {
  fullName: string;
  email: string;
  role: string;
}

/** What the API listed for People & Roles, read from a page of the site with the Super Admin's session. */
async function peopleFromApi(page: Page): Promise<SuperPerson[]> {
  const { apiUrl } = e2eLane();
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/v1/super/people`, { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  }, apiUrl);
  expect(answer.status, 'GET /v1/super/people').toBe(200);
  return (answer.body as { people: SuperPerson[] }).people;
}

/** `me` as the API says it to the person of this page. */
async function meOf(page: Page): Promise<MeUser> {
  const { apiUrl } = e2eLane();
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/v1/auth/me`, { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  }, apiUrl);
  expect(answer.status, 'GET /v1/auth/me').toBe(200);
  return (answer.body as MeResponse).user;
}

/**
 * People tab: "+ Add person", the form, the password step (`onPasswordStep` may look at it before the password is typed). Stops with the temporary password dialog on screen and answers with
 * the temporary password: the caller keeps it in a variable and never prints it.
 */
async function addPersonUntilShown(
  page: Page,
  person: NewPerson,
  superPassword: string,
  options: { onPasswordStep?: (step: Locator) => Promise<void> } = {}
): Promise<string> {
  await page.getByRole('tab', { name: 'People' }).click();
  await expect(page.getByTestId('people-tab')).toBeVisible();
  await page.getByTestId('add-person').click();
  const form = page.getByTestId('add-person-dialog');
  await expect(form).toBeVisible();
  await form.getByTestId('add-person-name').fill(person.fullName);
  await form.getByTestId('add-person-email').fill(person.email);
  await form.getByTestId('add-person-role').selectOption({ label: person.role });
  await form.getByTestId('add-person-continue').click();

  const step = page.getByTestId('confirm-password-dialog');
  await expect(step).toBeVisible();
  await expect(step).toContainText(`Add ${person.fullName} (${person.email}) as ${person.role}`);
  await options.onPasswordStep?.(step);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/super/people' &&
      response.request().method() === 'POST'
  );
  await confirmWithPassword(page, superPassword);
  expect((await created).status(), 'POST /v1/super/people answers 201').toBe(201);

  const dialog = page.getByTestId('temporary-password-dialog');
  await expect(dialog).toBeVisible();
  return ((await dialog.getByTestId('temporary-password').textContent()) ?? '').trim();
}

/** "I have copied it": the one way out of the temporary password dialog. */
async function closeTemporaryPassword(page: Page): Promise<void> {
  await page.getByTestId('temporary-password-done').click();
  await expect(page.getByTestId('temporary-password-dialog')).toHaveCount(0);
}

/** A person added through the screen, the dialog closed again; answers with the temporary password. */
async function addPerson(page: Page, person: NewPerson, superPassword: string): Promise<string> {
  const temporary = await addPersonUntilShown(page, person, superPassword);
  await closeTemporaryPassword(page);
  await expect(page.getByTestId('person-row').filter({ hasText: person.email })).toBeVisible();
  return temporary;
}

/**
 * The first sign-in of a person who has the temporary password: the login screen, then the screen that asks for a password of their own (U11), then the application. The person's own
 * password is `chosen`. Nothing a password is typed with is written down: every field is typed by the keyboard.
 */
async function firstSignIn(
  page: Page,
  person: { email: string; fullName: string },
  temporary: string,
  chosen: string
): Promise<void> {
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(person.email);
  await typeSecret(page, page.getByLabel('Password'), temporary);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible({
    timeout: TIME_TO_SIGN_IN,
  });
  // nothing else is offered until the password is changed
  await expect(page.locator('aside')).toHaveCount(0);
  await typeSecret(page, page.getByLabel('Current password'), temporary);
  await typeSecret(page, page.getByLabel('New password', { exact: true }), chosen);
  await typeSecret(page, page.getByLabel('Repeat the new password'), chosen);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(aside(page)).toContainText(person.fullName, { timeout: TIME_TO_SIGN_IN });
}

/**
 * The places of the page where a text is still to be found: its text, its markup (which holds the value of a field too), a field, the two Web Storage areas and the address. The answer holds
 * the names of the places and never the text, so a failing check does not print it.
 */
async function whereIs(page: Page, secret: string): Promise<string[]> {
  return page.evaluate((text) => {
    const found: string[] = [];
    if (document.body.innerText.includes(text)) found.push('the text of the page');
    if (document.documentElement.outerHTML.includes(text)) found.push('the markup of the page');
    const fields = Array.from(document.querySelectorAll('input, textarea'));
    if (fields.some((field) => (field as HTMLInputElement).value.includes(text)))
      found.push('a field of the page');
    for (const [name, store] of [
      ['local storage', window.localStorage],
      ['session storage', window.sessionStorage],
    ] as const) {
      for (let place = 0; place < store.length; place += 1) {
        const key = store.key(place) ?? '';
        if (key.includes(text) || (store.getItem(key) ?? '').includes(text)) {
          found.push(name);
          break;
        }
      }
    }
    if (window.location.href.includes(text)) found.push('the address');
    return found;
  }, secret);
}

/** A sync call of the browser: the resource as the address names it (`daily-rates`, `sku-private`) and the status the API answered. */
interface SyncCall {
  resource: string;
  status: number | null;
}

/** Every page of a hydrate this page asks the API for from now on (the poll is not a page), in the order asked. Empty it with `calls.length = 0` to look at the next hydrate alone. */
function trackSync(page: Page): SyncCall[] {
  const { apiUrl } = e2eLane();
  const calls: SyncCall[] = [];
  const mine = new Map<Request, SyncCall>();
  page.on('request', (request) => {
    if (!request.url().startsWith(`${apiUrl}/v1/sync/`)) return;
    const resource = new URL(request.url()).pathname.slice('/v1/sync/'.length);
    if (resource === 'poll') return;
    const call: SyncCall = { resource, status: null };
    mine.set(request, call);
    calls.push(call);
  });
  page.on('response', (response) => {
    const call = mine.get(response.request());
    if (call) call.status = response.status();
  });
  return calls;
}

/** The resources of some calls, each once, in letter order. */
const resourcesOf = (calls: readonly SyncCall[]): string[] =>
  Array.from(new Set(calls.map((call) => call.resource))).sort();

/** The errors the page threw (not the messages it logged): a screen that was left half drawn would show here. */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * The calls to the API that this page makes from now on and that the API refuses or fails (a status of 400 or more), as `403 GET /v1/...`. The one question every start of the application
 * asks before anybody is signed in, `me`, is answered 401 and is not a refusal of anything the person did: it is left out.
 */
function trackRefused(page: Page): string[] {
  const { apiUrl } = e2eLane();
  const refused: string[] = [];
  page.on('response', (response) => {
    if (!response.url().startsWith(apiUrl) || response.status() < 400) return;
    const call = `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`;
    if (call !== '401 GET /v1/auth/me') refused.push(call);
  });
  return refused;
}

/**
 * Nothing on the screen says that something went wrong: no alert inside the page (Next.js keeps an empty one of its own outside `main`), no "Offline" or "Waking up" banner, no "The latest
 * changes could not be loaded" line, no closed-screen card, and no sentence of a failure in the page's own words.
 */
async function expectNoErrorShown(page: Page, where: string): Promise<void> {
  await expect(page.locator('main').getByRole('alert'), `${where}: an alert`).toHaveCount(0);
  await expect(
    page.getByTestId('connection-banner'),
    `${where}: the connection banner`
  ).toHaveCount(0);
  await expect(
    page.getByTestId('poll-notice'),
    `${where}: the notice of a failed poll`
  ).toHaveCount(0);
  const words = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  expect(words, `${where}: the words of the page`).not.toMatch(
    /could not|couldn.t|can.t be loaded|try again|went wrong|not available for your role|offline|waking up/i
  );
  expect(words, `${where}: a figure or a name that was never filled in`).not.toMatch(
    /\bundefined\b|\bNaN\b|\bnull\b/
  );
}

/** The paths the links of the sidebar lead to (the query of a link is not part of the path), each once, in the order of the menu. */
async function menuPaths(page: Page): Promise<string[]> {
  const hrefs = await aside(page)
    .locator('a[href]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  return Array.from(new Set(hrefs.map((href) => new URL(href, 'http://site.test').pathname)));
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
      // the four logins of the lane, each with its role; hers carries the pill and the line that says what she may do to her own row. (A lane that other specs ran on holds more people, made
      // through the admin door: the list is not counted, each of the four is looked for.)
      const rows = page.getByTestId('person-row');
      await expect(rows.first()).toBeVisible();
      for (const [login, pill] of [
        ['owner', 'Owner'],
        ['biller', 'Biller'],
        ['staff', 'Staff'],
        ['super', 'Super Admin'],
      ] as const) {
        const row = rows.filter({ hasText: e2eLogin(login).email });
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(pill);
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

// ------------------------------------------------------------------------------------------------ 6: a person is added, and signs in

test.describe('a person added from the People tab', () => {
  test('add a person with the role Cashier: the temporary password is shown once; in a second browser context that person signs in, changes the password, sees Billing and not Reports and not People & Roles', async ({
    page,
    browser,
  }) => {
    const superAdmin = e2eLogin('super');
    const CASHIER = `Cashier ${RUN}`;
    const person: NewPerson = {
      fullName: `Meena Shah ${RUN}`,
      email: `meena-${RUN}@jv-e2e.test`,
      role: CASHIER,
    };
    const chosen = newPassword();

    // the role: a copy of the Biller, which makes bills (this test makes its own Cashier)
    await signInAs(page, superAdmin);
    await openPeopleAndRoles(page);
    await openRolesTab(page);
    await copyRole(page, {
      from: 'Biller',
      name: CASHIER,
      description: 'Makes bills at the counter.',
      password: superAdmin.password,
    });
    const cashier = await roleFromApi(page, CASHIER);

    // People tab: + Add person, the form, the password step, and then the temporary password
    const listed = (await peopleFromApi(page)).length;
    const temporary = await addPersonUntilShown(page, person, superAdmin.password);
    const dialog = page.getByTestId('temporary-password-dialog');
    await expect(dialog.getByRole('heading', { name: 'Person added' })).toBeVisible();
    await expect(dialog).toContainText(
      `${person.fullName} can now sign in with ${person.email} and this temporary password.`
    );
    await expect(dialog).toContainText('It is shown only once.');
    // the API made four groups of four (a check that does not print the password when it fails)
    expect(
      /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(temporary),
      'the temporary password has the shape of four groups of four'
    ).toBe(true);
    // the one way out is "I have copied it": Escape and a press beside the dialog do nothing, and there is no close cross
    await expect(dialog.getByRole('button')).toHaveText(['Copy', 'I have copied it']);
    await page.keyboard.press('Escape');
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('temporary-password')).toBeVisible();
    // the tabs are locked meanwhile: a change of tab would lose a password that is shown once
    await expect(page.getByRole('tab', { name: 'Roles' })).toBeDisabled();
    await closeTemporaryPassword(page);
    expect(
      await whereIs(page, temporary),
      'where the temporary password is still to be found once the dialog is closed'
    ).toEqual([]);

    // the list: the new person, with the role as a pill and active; and the API lists one login more
    const row = page.getByTestId('person-row').filter({ hasText: person.email });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(person.fullName);
    await expect(row).toContainText(CASHIER);
    await expect(row).toContainText('Active');
    await expect(row.getByRole('button')).toHaveText([
      'Edit',
      'Change role',
      'Reset password',
      'Switch off',
    ]);
    const people = await peopleFromApi(page);
    expect(people).toHaveLength(listed + 1);
    const added = people.find((one) => one.email === person.email);
    expect(added).toMatchObject({
      full_name: person.fullName,
      role_name: CASHIER,
      active: true,
      is_super_admin: false,
    });
    // nothing that looks like a password is in what the list says about a person
    expect(Object.keys(added ?? {}).filter((key) => /pass|hash|secret|token/i.test(key))).toEqual(
      []
    );

    // the same e-mail again, in capitals (the form cannot tell that it is taken, the API can): refused on the password step, in the API's words with "Nothing was changed." after them; the
    // step stays, Cancel brings the form back with what was typed, and nobody was added
    await page.getByTestId('add-person').click();
    const again = page.getByTestId('add-person-dialog');
    await again.getByTestId('add-person-name').fill(`Another ${RUN}`);
    await again.getByTestId('add-person-email').fill(person.email.toUpperCase());
    await again.getByTestId('add-person-role').selectOption({ label: CASHIER });
    await again.getByTestId('add-person-continue').click();
    const step = page.getByTestId('confirm-password-dialog');
    await expect(step).toBeVisible();
    await confirmWithPassword(page, superAdmin.password);
    await expect(step.getByTestId('confirm-password-error')).toHaveText(
      /already used by another user\. Nothing was changed\.$/
    );
    await expect(step).toBeVisible();
    await step.getByTestId('confirm-password-cancel').click();
    await expect(again.getByTestId('add-person-name')).toHaveValue(`Another ${RUN}`);
    await again.getByTestId('add-person-cancel').click();
    await expect(again).toHaveCount(0);
    expect(await peopleFromApi(page), 'people after a refused add').toHaveLength(listed + 1);

    // a second browser context: the person signs in with the temporary password, is asked for one of their own, and gets the menu of the role
    const second = await otherBrowser(browser);
    try {
      await firstSignIn(second.page, person, temporary, chosen);
      const bar = aside(second.page);
      await expect(bar.getByTestId('session-role')).toHaveText(CASHIER);
      // Billing: in the menu, and it opens (the screen is not the closed-screen card)
      await expect(bar.locator('a[href="/billing-pos"]')).toBeVisible();
      await expect(bar.getByRole('link', { name: 'New Estimate' })).toBeVisible();
      // no Reports and no People & Roles
      await expect(bar.getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);
      await expect(bar.locator('a[href="/reports"]')).toHaveCount(0);
      await expect(bar.getByRole('link', { name: 'People & Roles' })).toHaveCount(0);
      await expect(bar.locator('a[href="/people-roles"]')).toHaveCount(0);
      await bar.getByRole('link', { name: 'New Estimate' }).click();
      await expect(second.page).toHaveURL(/\/billing-pos\/?$/);
      await expect(second.page.getByText('Not available for your role')).toHaveCount(0);
      // `me` says the same: the ticks of the role, and no Super Admin flag
      const me = await meOf(second.page);
      expect(me.role_name).toBe(CASHIER);
      expect(me.is_super_admin).toBe(false);
      expect(me.permissions).toEqual(cashier.ticks);
      expect(me.permissions).toContain('bill_make');
      expect(me.permissions).not.toContain('reports_open');
    } finally {
      await second.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ 7: P6, a tick taken away while its person is signed in

test.describe('a tick taken away while its person is signed in', () => {
  test('P6: the Super Admin turns "Make bills and estimates" off for Cashier; the signed-in person loses Billing in the menu at the next poll, /billing-pos shows the closed-screen card (Not available for your role) with a way back to the dashboard, and the next hydrate asks only for what they may read', async ({
    page,
    browser,
  }) => {
    const superAdmin = e2eLogin('super');
    const CASHIER = `Cashier P6 ${RUN}`;
    const person: NewPerson = {
      fullName: `Ravi Kumar ${RUN}`,
      email: `ravi-${RUN}@jv-e2e.test`,
      role: CASHIER,
    };
    const chosen = newPassword();

    // the Super Admin: a copy of the Biller (it makes bills), and a person who has it
    await signInAs(page, superAdmin);
    await openPeopleAndRoles(page);
    await openRolesTab(page);
    await copyRole(page, { from: 'Biller', name: CASHIER, password: superAdmin.password });
    const temporary = await addPerson(page, person, superAdmin.password);

    // the person, in a browser context of their own, signs in for the first time and stays on the billing screen
    const second = await otherBrowser(browser);
    try {
      const asked = trackSync(second.page);
      const thrown = trackPageErrors(second.page);
      const refused = trackRefused(second.page);
      await firstSignIn(second.page, person, temporary, chosen);
      const bar = aside(second.page);
      await bar.getByRole('link', { name: 'New Estimate' }).click();
      await expect(second.page).toHaveURL(/\/billing-pos\/?$/);
      await expect(second.page.getByText('Not available for your role')).toHaveCount(0);
      await expect(bar.locator('a[href="/order-book"]')).toBeVisible();

      // what the person may do and read now, and what the hydrate of the sign-in asked for: exactly that
      const before = await meOf(second.page);
      expect(before.permissions).toEqual(
        expect.arrayContaining(['bill_make', 'order_view', 'order_edit'])
      );
      expect(before.reads).toContain('orders');
      expect(resourcesOf(asked), 'tables of the first hydrate').toEqual([...before.reads].sort());
      expect(asked.every((call) => call.status === 200)).toBe(true);

      // The Super Admin turns "Make bills and estimates" off. Her save also turns the Order Book off ("Make and change orders" goes first: it needs the Order Book), so that what the person
      // may READ changes too and the hydrate that follows has something to show: without it the tables would be the same before and after.
      await page.getByRole('tab', { name: 'Roles' }).click();
      await page.getByRole('button', { name: `Edit ${CASHIER}`, exact: true }).click();
      await expect(page.getByTestId('edit-role-name')).toHaveValue(CASHIER);
      await toggleTick(page, 'Make bills and estimates');
      await toggleTick(page, 'Make and change orders, add order photos');
      await toggleTick(page, 'See the Order Book');
      for (const words of [
        'Make bills and estimates',
        'Make and change orders, add order photos',
        'See the Order Book',
      ]) {
        await expect(tickBox(page, words)).not.toBeChecked();
      }
      await expect(page.getByTestId('edit-role-banner')).toContainText('3 changes not saved yet');
      const mark = asked.length; // the calls from here on belong to what follows the change
      await page.getByTestId('edit-role-head-save').click();
      await confirmWithPassword(page, superAdmin.password);
      await expect(page.getByTestId('edit-role-saved')).toHaveText('Saved.');
      const savedAt = Date.now();
      const saved = await roleFromApi(page, CASHIER);
      expect(saved.ticks).not.toContain('bill_make');
      expect(saved.ticks).not.toContain('order_view');
      expect(saved.ticks).not.toContain('order_edit');

      // the person touches nothing: at the next poll the screen they stand on is the closed-screen card (a state, not a pause: 8 seconds of poll and a hydrate)
      const closed = second.page.getByRole('heading', {
        level: 1,
        name: 'Not available for your role',
      });
      await expect(closed).toBeVisible({ timeout: 45_000 });
      test.info().annotations.push({
        type: 'seconds from the save to the closed screen',
        description: String(Math.round((Date.now() - savedAt) / 1000)),
      });
      await expect(second.page).toHaveURL(/\/billing-pos\/?$/);
      // the menu: no Billing, no Saved Estimates, no Order Book, and no Sales group; what the person still has stays
      await expect(bar.locator('a[href="/billing-pos"]')).toHaveCount(0);
      await expect(bar.locator('a[href="/estimate"]')).toHaveCount(0);
      await expect(bar.locator('a[href="/order-book"]')).toHaveCount(0);
      await expect(bar.getByRole('button', { name: 'Sales', exact: true })).toHaveCount(0);
      await expect(bar.getByRole('button', { name: 'Customers', exact: true })).toBeVisible();

      // the hydrate that followed the change asked only for what the person may read now: no Order Book
      const after = await meOf(second.page);
      expect(after.permissions).not.toContain('bill_make');
      expect(after.reads).not.toContain('orders');
      expect(after.access, 'the access text of `me`').not.toBe(before.access);
      const followed = asked.slice(mark);
      expect(followed.length, 'pages asked for after the change').toBeGreaterThan(0);
      expect(
        resourcesOf(followed).filter((resource) => !after.reads.includes(resource)),
        'tables asked for that the person may not read'
      ).toEqual([]);
      expect(resourcesOf(followed), 'tables of the hydrate that followed the change').toEqual(
        [...after.reads].sort()
      );
      expect(followed.every((call) => call.status === 200)).toBe(true);
      // the person's next call was refused: the poll, which still asked for the Order Book (403), and nothing else of theirs was refused
      expect(refused.length, 'calls of the person that were refused').toBeGreaterThan(0);
      expect(
        refused.filter((call) => call !== '403 POST /v1/sync/poll'),
        'refused calls other than the poll'
      ).toEqual([]);

      // a reload of the address: the same card, and again the hydrate asks only for what `me` says
      asked.length = 0;
      await second.page.reload();
      await expect(closed).toBeVisible({ timeout: TIME_TO_SIGN_IN });
      await expect(bar).toContainText(person.fullName);
      expect(
        resourcesOf(asked).filter((resource) => !after.reads.includes(resource)),
        'tables asked for after a reload that the person may not read'
      ).toEqual([]);
      expect(resourcesOf(asked), 'tables of the hydrate of the reload').toEqual(
        [...after.reads].sort()
      );
      expect(asked.every((call) => call.status === 200)).toBe(true);

      // the way back: the card's button leads to the dashboard
      await second.page.getByRole('link', { name: 'Go to Dashboard' }).click();
      await expect(second.page).toHaveURL(/\/$/);
      await expect(closed).toHaveCount(0);
      await expect(second.page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(thrown, "errors thrown in the person's page").toEqual([]);
    } finally {
      await second.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ 8: P8, a role with no ticks

/** The screens that everybody who is signed in has: no tick opens them (`open` in the route table of the website). */
const OPEN_PATHS = SCREENS.filter((screen) => 'open' in screen.rule).map((screen) => screen.path);

test.describe('a role with no ticks', () => {
  test('P8: a role with no ticks: the person signs in and sees only the always-on screens with no error banner', async ({
    page,
    browser,
  }) => {
    const superAdmin = e2eLogin('super');
    const NOTHING = `No ticks ${RUN}`;
    const person: NewPerson = {
      fullName: `Sunita Rao ${RUN}`,
      email: `sunita-${RUN}@jv-e2e.test`,
      role: NOTHING,
    };
    const chosen = newPassword();

    // the role: a copy of the Staff role (five ticks, none of which another needs), every tick turned off, saved
    await signInAs(page, superAdmin);
    await openPeopleAndRoles(page);
    await openRolesTab(page);
    const staff = await roleFromApi(page, 'Staff');
    expect(staff.ticks, 'the five ticks of the Staff').toHaveLength(5);
    await copyRole(page, { from: 'Staff', name: NOTHING, password: superAdmin.password });
    await page.getByRole('button', { name: `Edit ${NOTHING}`, exact: true }).click();
    await expect(page.getByTestId('edit-role-name')).toHaveValue(NOTHING);
    // from the last tick of the catalogue back: a tick that another one needs is never the first to go
    for (const key of [...staff.ticks].sort(byCatalogue).reverse()) {
      await toggleTick(page, TICK_LABELS[key]);
      await expect(tickBox(page, TICK_LABELS[key])).not.toBeChecked();
    }
    await expect(page.getByTestId('edit-role-banner')).toContainText('5 changes not saved yet');
    await page.getByTestId('edit-role-head-save').click();
    await confirmWithPassword(page, superAdmin.password);
    await expect(page.getByTestId('edit-role-saved')).toHaveText('Saved.');
    expect((await roleFromApi(page, NOTHING)).ticks, 'the saved role').toEqual([]);
    await page.getByTestId('edit-role-back').click();
    await expect(roleRow(page, NOTHING)).toContainText('0 of 32 ticks');

    // a person with it, who signs in for the first time
    const temporary = await addPerson(page, person, superAdmin.password);
    const second = await otherBrowser(browser);
    try {
      const asked = trackSync(second.page);
      const thrown = trackPageErrors(second.page);
      const refused = trackRefused(second.page);
      await firstSignIn(second.page, person, temporary, chosen);
      const bar = aside(second.page);
      await expect(bar.getByTestId('session-role')).toHaveText(NOTHING);

      // `me`: no tick at all, and the tables that everybody reads
      const me = await meOf(second.page);
      expect(me.permissions, 'ticks of a role with none').toEqual([]);
      expect(me.is_super_admin).toBe(false);
      expect(me.reads.sort(), 'what a person with no ticks reads').toEqual([
        'categories',
        'daily-rates',
        'designs',
        'settings',
        'skus',
        'subcategories',
        'users',
      ]);
      expect(resourcesOf(asked), 'tables of the hydrate').toEqual([...me.reads].sort());
      expect(asked.every((call) => call.status === 200)).toBe(true);

      // the menu leads to the screens that everybody has, and to no other
      const paths = await menuPaths(second.page);
      expect(paths.length).toBeGreaterThan(1);
      expect(
        paths.filter((path) => !OPEN_PATHS.includes(path)),
        'menu links that lead to a screen outside the always-on ones'
      ).toEqual([]);
      for (const name of ['Dashboard', 'Designs', 'Stock Catalogue (PDF)']) {
        await expect(bar.getByRole('link', { name }).first()).toBeVisible();
      }
      // the groups of the menu that are left: the two that hold only open screens
      await expect(bar.locator('button[aria-expanded]')).toHaveText(['Inventory', 'Stock']);
      for (const name of [
        'New Estimate',
        'Saved Estimates',
        'Customers & Ledger',
        'Order Book',
        'Reports',
        'Scan Article',
        'Add Design',
        'Edit Stock',
        'Activity Log',
        'Business Settings',
        'People & Roles',
      ]) {
        await expect(bar.getByRole('link', { name, exact: true }), name).toHaveCount(0);
      }

      // the dashboard, where the person landed, and each other always-on screen, opened by its address: it is drawn and says nothing about a failure
      await expect(second.page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoErrorShown(second.page, 'the dashboard');
      for (const path of OPEN_PATHS.filter((open) => open !== '/')) {
        await second.page.goto(path);
        await expect(bar).toContainText(person.fullName, { timeout: TIME_TO_SIGN_IN });
        await expect(second.page.locator('main')).not.toBeEmpty();
        await expectNoErrorShown(second.page, path);
      }
      expect(thrown, "errors thrown in the person's page").toEqual([]);
      expect(refused, 'calls to the API that were refused').toEqual([]);
    } finally {
      await second.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ 9: a phone

test.describe('People & Roles on a phone', () => {
  // a fresh browser context at the size of the phone: the page of each test is its own context, so nothing has to be put back afterwards
  test.use({ viewport: PHONE });

  test('phone 375x812: People and Edit role are usable, the Save bar is visible, and there is no horizontal scroll', async ({
    page,
  }) => {
    const superAdmin = e2eLogin('super');
    const ROLE = `Phone role ${RUN}`;
    const person: NewPerson = {
      fullName: `Geeta Nair ${RUN}`,
      email: `geeta-${RUN}@jv-e2e.test`,
      role: ROLE,
    };

    /** The page is not wider than the window (`document.documentElement.scrollWidth <= window.innerWidth`), and nothing inside `main` scrolls sideways either. */
    const fits = async (where: string): Promise<void> => {
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(inner, 'the window is as wide as the phone').toBe(PHONE.width);
      expect(
        scroll,
        `${where}: the page is ${scroll} px wide in a window of ${inner} px`
      ).toBeLessThanOrEqual(inner);
      await expectNoSidewaysScroll(page);
    };
    /** The element lies whole between the left and the right edge of the phone (a dialog scrolls up and down on its own, never sideways). */
    const inside = async (element: Locator, what: string): Promise<void> => {
      const box = await element.boundingBox();
      expect(box, `${what} has a box`).not.toBeNull();
      expect(box!.x, `${what} starts inside the screen`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${what} ends inside the screen`).toBeLessThanOrEqual(
        PHONE.width
      );
    };

    // sign in, and reach the screen the way a phone does: through the menu button
    await signInAs(page, superAdmin);
    const menuButton = page.getByRole('button', { name: 'Open menu' });
    await expect(menuButton).toBeVisible();
    await menuButton.click();
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    const entry = drawer.getByRole('link', { name: 'People & Roles' });
    await expectTappable(entry);
    await entry.click();
    await expect(page).toHaveURL(/\/people-roles\/?$/);
    await expect(page.getByRole('heading', { level: 1, name: 'People & Roles' })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'People and roles' })).toBeVisible();

    // People: one card for each person, not a table; the Owner's card has its four buttons, hers has Edit and the line that says why there are no more, and "+ Add person" is whole
    await expect(page.getByTestId('person-row').first()).toBeVisible();
    await expect(page.getByTestId('person-row').first()).toHaveCSS('display', 'block');
    await expect(page.getByTestId('people-table').locator('thead')).toBeHidden();
    const owner = page.getByTestId('person-row').filter({ hasText: e2eLogin('owner').email });
    await expect(owner).toContainText('Owner');
    await expect(owner).toContainText('Active');
    for (const id of ['person-edit', 'person-role', 'person-reset', 'person-switch']) {
      await expectTappable(owner.getByTestId(id));
    }
    const own = page.getByTestId('person-row').filter({ hasText: superAdmin.email });
    await expect(own).toContainText('Super Admin');
    await expectTappable(own.getByTestId('person-edit'));
    await inside(own.getByTestId('person-lock-line'), 'the lock line of her own card');
    await expectTappable(page.getByTestId('add-person'));
    await fits('People');

    // the Roles tab: one card for each role, its buttons whole; Copy makes the role that the rest of the test uses
    await openRolesTab(page);
    await expect(page.getByTestId('role-row').first()).toHaveCSS('display', 'block');
    await expectTappable(page.getByRole('button', { name: 'Copy Staff', exact: true }));
    await expectTappable(page.getByRole('button', { name: 'Edit Biller', exact: true }));
    await fits('Roles');
    await copyRole(page, { from: 'Staff', name: ROLE, password: superAdmin.password });
    await fits('Roles, after a role was made');

    // Add person on the phone: the form, the password step and the temporary password fit, and every control is whole
    await page.getByRole('tab', { name: 'People' }).click();
    const temporary = await addPersonUntilShown(page, person, superAdmin.password, {
      onPasswordStep: async (step) => {
        await inside(step, 'the password step');
        await expectTappable(step.getByTestId('confirm-password-input'));
        await expectTappable(step.getByTestId('confirm-password-cancel'));
        await fits('the password step');
      },
    });
    const shown = page.getByTestId('temporary-password-dialog');
    await inside(shown, 'the temporary password dialog');
    await inside(shown.getByTestId('temporary-password'), 'the temporary password');
    await expectTappable(shown.getByTestId('temporary-password-done'));
    await fits('the temporary password');
    await closeTemporaryPassword(page);
    expect(await whereIs(page, temporary), 'where the temporary password is to be found').toEqual(
      []
    );
    await fits('People, after a person was added');

    // Edit role: the editor, with its Save bar at the bottom of the screen (the Save of the heading is not drawn)
    await openRolesTab(page);
    await page.getByRole('button', { name: `Edit ${ROLE}`, exact: true }).click();
    await expect(page.getByTestId('edit-role-name')).toHaveValue(ROLE);
    await fits('Edit role');
    const save = page.getByTestId('edit-role-phone-save');
    await expect(page.getByTestId('edit-role-head-save')).toBeHidden();
    await expect(save).toBeVisible();
    await expect(save).toBeDisabled(); // nothing has been changed yet

    // a change, and the bar is for it: Save is ready, it is whole, in the lower half of the screen, above the bottom bar, and a tap reaches it
    await toggleTick(page, 'Open Reports');
    await expect(tickBox(page, 'Open Reports')).toBeChecked();
    await expect(page.getByTestId('edit-role-banner')).toContainText('1 change not saved yet');
    await expect(save).toBeEnabled();
    const bar = page.getByTestId('edit-role-phone-bar');
    const barIsAtTheBottom = async (): Promise<void> => {
      const box = await bar.boundingBox();
      expect(box, 'the Save bar has a box').not.toBeNull();
      expect(box!.y + box!.height, 'the Save bar ends inside the screen').toBeLessThanOrEqual(
        PHONE.height
      );
      expect(box!.y, 'the Save bar is in the lower half of the screen').toBeGreaterThan(
        PHONE.height / 2
      );
    };
    await barIsAtTheBottom();
    await expectTappable(save);
    // the bar goes with the page: the last tick of the catalogue is far below, and the bar is still there
    await tickBox(page, 'Change shop settings').scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    await barIsAtTheBottom();
    await expectTappable(save);
    await fits('Edit role with a change');

    // and the bar saves: the password step on the phone, then "Saved."
    await save.click();
    const step = page.getByTestId('confirm-password-dialog');
    await expect(step).toBeVisible();
    await inside(step, 'the password step of the Save');
    await fits('the password step of the Save');
    await confirmWithPassword(page, superAdmin.password);
    await expect(page.getByTestId('edit-role-saved')).toHaveText('Saved.');
    await expect(save).toBeDisabled();
    expect((await roleFromApi(page, ROLE)).ticks).toContain('reports_open');
    await fits('Edit role, saved');
  });
});

// ------------------------------------------------------------------------------------------------ 10: the Activity Log

test.describe("the Activity Log tells the Super Admin's changes", () => {
  test('the Activity Log (opened as the Owner) shows the Super Admin\'s changes in words, for example "New role Cashier" and "Person added <name>"', async ({
    page,
    browser,
  }) => {
    const superAdmin = e2eLogin('super');
    const owner = e2eLogin('owner');
    const CASHIER = `Cashier log ${RUN}`;
    const person: NewPerson = {
      fullName: `Asha Verma ${RUN}`,
      email: `asha-${RUN}@jv-e2e.test`,
      role: CASHIER,
    };

    // the Super Admin's changes: a new role, a person with it, and a tick turned on for the role
    await signInAs(page, superAdmin);
    await openPeopleAndRoles(page);
    await openRolesTab(page);
    await copyRole(page, { from: 'Biller', name: CASHIER, password: superAdmin.password });
    await addPerson(page, person, superAdmin.password);
    await openRolesTab(page);
    await page.getByRole('button', { name: `Edit ${CASHIER}`, exact: true }).click();
    await expect(page.getByTestId('edit-role-name')).toHaveValue(CASHIER);
    await toggleTick(page, 'Open Reports');
    await page.getByTestId('edit-role-head-save').click();
    await confirmWithPassword(page, superAdmin.password);
    await expect(page.getByTestId('edit-role-saved')).toHaveText('Saved.');

    // the Owner opens the Activity Log (the login screen first: the address is the log)
    const second = await otherBrowser(browser);
    try {
      await second.page.goto('/activity-log');
      await expect(second.page.getByLabel('Email')).toBeVisible();
      await second.page.getByLabel('Email').fill(owner.email);
      await typeSecret(second.page, second.page.getByLabel('Password'), owner.password);
      await second.page.getByRole('button', { name: 'Sign in' }).click();
      await expect(
        second.page.getByRole('heading', { level: 1, name: 'Activity Log' })
      ).toBeVisible({
        timeout: TIME_TO_SIGN_IN,
      });
      const rows = second.page.getByTestId('activity-row');
      await expect(rows.first()).toBeVisible();

      // each change is in the log in the words of the screen, by the Super Admin. A change can be in the log twice (the row the database's audit writes for the table, and the event the API
      // writes for the change), so a row is looked for and not counted
      const lines = [
        `New role ${CASHIER}`,
        `Person added ${person.fullName}`,
        `Role ${CASHIER}: turned on Open Reports`,
      ];
      for (const words of lines) {
        const found = rows.filter({
          has: second.page.getByRole('cell', { name: words, exact: true }),
        });
        await expect(found.first(), `a row that says "${words}"`).toBeVisible();
        await expect(found.first()).toContainText(superAdmin.fullName);
        test.info().annotations.push({
          type: `rows that say "${words}"`,
          description: String(await found.count()),
        });
      }
      // no key, no id and no gap in the words of those changes
      const ours = await rows
        .filter({ hasText: RUN })
        .evaluateAll((trs) => trs.map((tr) => (tr.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(ours.length).toBeGreaterThanOrEqual(lines.length);
      for (const text of ours) expect(text).not.toMatch(/_|undefined|\bnull\b|\bNaN\b/);
    } finally {
      await second.close();
    }
  });
});
