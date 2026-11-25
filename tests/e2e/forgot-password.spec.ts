import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { e2eLane, e2eOutbox } from './global-setup';
import { typeSecret } from './secret';

// Forgot password by e-mail (DESIGN, part 2), in a real browser against the real API of a lane: the "Forgot password?" link of the sign-in screen, the forgot screen, the mail, the reset screen
// and what a saved password does. The lane's API runs with the outbox mailer (scripts/e2e-lane.mjs): nothing is sent, each mail it would send is a JSON file in the lane's outbox folder
// (`e2eOutbox()`: `<ISO time>-<12 hex>.json` with to, subject, text and html), and the link is read from the `text` of that file.
//
//   1  an unknown e-mail: the screen says the same sentence as for a login, and no file for that address lands in the outbox
//   2  the flow: sign-in -> "Forgot password?" -> the e-mail -> the sentence -> the mail in the outbox -> its link -> the address bar loses `#t=` -> two new-password fields (an eye button shows
//      one of them) -> the success sentence -> the old password is refused and the new one signs in
//   3  the same link again: the form opens (the page cannot know) and Save shows the bad-link sentence with its two links; a reload of that page does too; the password stays the first new one
//   4  a browser that is signed in as the login opens the link: the reset screen, not the application; after Save the session store asks `me` at once (a 401 within seconds, no 8-second poll),
//      the sign-in screen is what the browser shows, also after a reload
//
// LIMITS OF THE API (in memory, per API process, so per run of the lane): forgot-password sends nothing for a 4th ask for one e-mail within an hour, nor past 10 asks an hour from one address. The
// page and this process call the API with no x-real-ip header, so every call shares the address key "unknown". The spec makes 5 asks in all (test 1 asks for its unknown e-mail and, as a control, for
// a login of its own; tests 2, 3 and 4 one each, every one for a login made for that test alone), so it stays under 10 for the run and under 3 for each e-mail, and a retry makes new logins.
// The lane's four logins are never used: a reset ends every session of its login and changes its password, and other specs sign in with them.
//
// THE PASSWORDS. Made at run time, typed with the keyboard (`typeSecret`, tests/e2e/secret.ts) and never printed, compared or put in a title. Nothing here asserts on a password field once something
// has been typed into it, not even on its `type` attribute: the field is a controlled React input, which keeps the typed text in its `value` attribute, and the call log of a failing assertion prints the
// element it resolved to, `<input ... value="...">`. The type of a typed-into field is checked with the number of elements that match `input[type=...]`, and a failing `toHaveCount` prints only that number.
// Nor does anything assert on a mail's text as a whole (a failing assertion prints it, link included): a check that a mail holds a link says true or false.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api with the reset routes> npx playwright test tests/e2e/forgot-password.spec.ts --reporter=line

const LINK_SENT_WORDS =
  'If this e-mail has a login, a link is on its way. It works once, within 30 minutes. No mail in 5 minutes (look in Spam too)? Ask the Super Admin to reset your password from People & Roles.';
const BAD_LINK_WORDS = 'This link has expired or was already used. Ask for a new one.';
const CHANGED_WORDS = 'Your password is changed. Sign in with it.';
const MAIL_SUBJECT = 'Reset your password: Jaishri Gold Palace';
const TIME_TO_SIGN_IN = 60_000;

test.describe.configure({ timeout: 120_000 }); // the first visit of a page compiles it, and a sign-in loads the data

/** The sidebar of the application. */
const aside = (page: Page) => page.locator('aside');

// ------------------------------------------------------------------------------------------------ logins made for this spec

interface MadeUser {
  email: string;
  fullName: string;
  /** The password the login has now (made at run time). */
  password: string;
}

/** A call to the admin door of the lane (the door refuses an Origin, so from this process, not from a page). */
async function admin(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const { apiUrl, adminToken } = e2eLane();
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

/** A call the way the site makes it (its Origin, X-JV-Client), from this process. */
async function asSite(
  pathName: string,
  options: { body?: unknown; cookie?: string } = {}
): Promise<{ status: number; json: unknown; cookie: string | null }> {
  const { apiUrl, webOrigin } = e2eLane();
  const headers: Record<string, string> = { origin: webOrigin, 'x-jv-client': 'web' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`${apiUrl}${pathName}`, {
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

/** A password made now: 10 or more characters, nothing of the e-mail in it (U9). */
const newPassword = () => `${randomBytes(12).toString('base64url')}-Aa1`;

/** An ordinary biller made through the admin door, signed in once with the temporary password and given one of its own, so that no change-password gate is in the way (as login.spec.ts does). */
async function makeSettledUser(tag: string): Promise<MadeUser> {
  const email = `forgot-${tag}-${randomBytes(4).toString('hex')}@jv-e2e.test`; // lower case: the outbox's `to` is the stored address
  const fullName = `E2E forgot ${tag}`;
  const made = await admin('/admin/v1/users', { email, full_name: fullName, role: 'biller' });
  expect(made.status, 'the admin door made the user').toBe(201);
  const temporary = (made.json as { temporary_password: string }).temporary_password;
  const login = await asSite('/v1/auth/login', { body: { email, password: temporary } });
  expect(login.status, 'the first login with the temporary password').toBe(200);
  const password = newPassword();
  const changed = await asSite('/v1/auth/change-password', {
    cookie: login.cookie ?? '',
    body: { current_password: temporary, new_password: password },
  });
  expect(changed.status, 'the password change').toBe(200);
  await asSite('/v1/auth/logout', { cookie: login.cookie ?? '' });
  return { email, fullName, password };
}

/** Asks for a link the way the forgot screen does, from this process (tests 1 control, 3 and 4: the screen is test 2's). The API answers 202 for every e-mail. */
async function askForLink(email: string): Promise<void> {
  const answer = await asSite('/v1/auth/forgot-password', { body: { email } });
  expect(answer.status, 'forgot-password answers 202').toBe(202);
}

// ------------------------------------------------------------------------------------------------ the outbox

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** The mails addressed to `email`, oldest first (the file names start with the ISO time, so the names sort by time). A file that is still being written is skipped; the next look finds it. */
function mailsTo(email: string): Mail[] {
  const dir = e2eOutbox();
  const found: Mail[] = [];
  for (const name of readdirSync(dir)
    .filter((one) => one.endsWith('.json'))
    .sort()) {
    try {
      const mail = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Mail;
      if (mail.to === email) found.push(mail);
    } catch {
      // half written
    }
  }
  return found;
}

/** Waits for the mail of the login (the API writes it after it has answered) and returns the newest one. */
async function newestMailTo(email: string): Promise<Mail> {
  await expect
    .poll(() => mailsTo(email).length, {
      message: 'a mail for the login reached the outbox',
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  return mailsTo(email).at(-1) as Mail;
}

/** The link of a reset mail: `<site>/reset-password#t=<43-character token>`. It is never printed: a check on it says true or false. */
function linkOf(mail: Mail): string {
  const found = /https?:\/\/\S+#t=[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/.exec(mail.text);
  expect(found !== null, 'the mail holds a reset link').toBe(true);
  const link = (found as RegExpExecArray)[0];
  expect(
    link.startsWith(`${e2eLane().webOrigin}/reset-password#t=`),
    'the link opens the lane site'
  ).toBe(true);
  return link;
}

/** Asks for a link from this process and waits for its mail: the link. */
async function linkFor(email: string): Promise<string> {
  await askForLink(email);
  return linkOf(await newestMailTo(email));
}

// ------------------------------------------------------------------------------------------------ the screens

const newPasswordField = (page: Page) => page.getByLabel('New password', { exact: true }); // "Repeat the new password" holds the words too
const repeatField = (page: Page) => page.getByLabel('Repeat the new password');

/** Opens the page of a link in `page` and waits for the form; by then the page has taken the token out of the address bar. */
async function openLink(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect(newPasswordField(page)).toBeVisible();
  expect(page.url().includes('#t='), 'the address bar has no token').toBe(false);
}

/** Types the new password in both fields and presses Save. */
async function saveNewPassword(page: Page, password: string): Promise<void> {
  await typeSecret(page, newPasswordField(page), password);
  await typeSecret(page, repeatField(page), password);
  await page.getByRole('button', { name: 'Save new password' }).click();
}

/** Signs in through the sign-in screen that is open; waits for the application. */
async function signInOnScreen(
  page: Page,
  who: { email: string; fullName: string },
  password: string
): Promise<void> {
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(''); // empty, so nothing secret goes through `fill`; the field may hold an earlier try
  await typeSecret(page, page.getByLabel('Password'), password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: TIME_TO_SIGN_IN });
}

/** The status of `me` as this page asks it (cookie included). */
async function meStatus(page: Page): Promise<number> {
  const { apiUrl } = e2eLane();
  return page.evaluate(
    async (url) => (await fetch(`${url}/v1/auth/me`, { credentials: 'include' })).status,
    apiUrl
  );
}

// ------------------------------------------------------------------------------------------------ the tests

test.describe('forgot password by e-mail', () => {
  test('unknown e-mail: same sentence, no file in the outbox', async ({ page }) => {
    const unknown = `nobody-${randomBytes(4).toString('hex')}@jv-e2e.test`;
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(unknown);
    await page.getByRole('button', { name: 'Send link' }).click();
    // the same sentence as for a login, and nothing that says the address has none
    await expect(page.getByText(LINK_SENT_WORDS, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);

    // The API writes a mail after it has answered, so "no file yet" proves little by itself. A control: a login of its own is asked for in the same way, and once its mail is in the outbox the
    // work after the unknown ask (which started first and has the shorter way) is long over.
    const control = await makeSettledUser('control');
    await askForLink(control.email);
    await newestMailTo(control.email);
    expect(mailsTo(unknown).length, 'mails for the unknown e-mail').toBe(0);
    expect(mailsTo(control.email).length, 'mails for the control login').toBe(1);
  });

  test('the flow', async ({ page }) => {
    const user = await makeSettledUser('flow');
    const chosen = newPassword();

    // sign-in -> "Forgot password?" -> the e-mail
    await page.goto('/');
    await expect(page.getByLabel('Email')).toBeVisible();
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password\/?$/);
    await page.getByLabel('Email').fill(user.email);
    await page.getByRole('button', { name: 'Send link' }).click();
    await expect(page.getByText(LINK_SENT_WORDS, { exact: true })).toBeVisible();

    // the mail
    const mail = await newestMailTo(user.email);
    expect(mail.subject).toBe(MAIL_SUBJECT);
    expect(mailsTo(user.email).length, 'one ask, one mail').toBe(1);
    const link = linkOf(mail);

    // the link: the reset screen, the token out of the address bar, two fields with an eye button each
    await openLink(page, link);
    expect(await page.evaluate(() => window.location.pathname)).toBe('/reset-password');
    await expect(aside(page)).toHaveCount(0);
    await typeSecret(page, newPasswordField(page), chosen);
    await typeSecret(page, repeatField(page), chosen);
    // counts and never the fields' own attributes: they hold what was typed (see THE PASSWORDS)
    const hidden = page.locator('input[type="password"]');
    const shown = page.locator('input[type="text"]');
    await expect(hidden).toHaveCount(2);
    await expect(shown).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show what you typed' })).toHaveCount(2);
    await page.getByRole('button', { name: 'Show what you typed' }).first().click(); // the eye of "New password", the first field
    await expect(shown).toHaveCount(1);
    await expect(hidden).toHaveCount(1);
    await expect(newPasswordField(page).and(shown)).toHaveCount(1); // it is "New password" that shows its text
    await expect(repeatField(page).and(hidden)).toHaveCount(1); // and "Repeat the new password" that stays hidden
    await expect(page.getByRole('button', { name: 'Hide what you typed' })).toHaveCount(1);

    // saved
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByText(CHANGED_WORDS, { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Email')).toBeVisible();

    // the old password is refused, the new one signs in
    await page.getByLabel('Email').fill(user.email);
    await typeSecret(page, page.getByLabel('Password'), user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByText('Wrong email or password')).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    await signInOnScreen(page, user, chosen);
  });

  test('the same link again shows the bad-link sentence', async ({ page }) => {
    const user = await makeSettledUser('twice');
    const link = await linkFor(user.email);
    const first = newPassword();

    await openLink(page, link);
    await saveNewPassword(page, first);
    await expect(page.getByText(CHANGED_WORDS, { exact: true })).toBeVisible();

    // The first page now sits on /reset-password with no hash, so a goto of the link would only be a change of the hash on the same document: the link is opened in a page of its own.
    const again = await page.context().newPage();
    await openLink(again, link); // the page cannot know that the link was used: the form opens
    await saveNewPassword(again, newPassword());
    await expect(again.getByText(BAD_LINK_WORDS, { exact: true })).toBeVisible();
    await expect(again.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
    await expect(again.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/');
    await expect(newPasswordField(again)).toHaveCount(0);

    // a reload finds no token in the address any more: the same sentence
    await again.reload();
    await expect(again.getByText(BAD_LINK_WORDS, { exact: true })).toBeVisible();
    await expect(newPasswordField(again)).toHaveCount(0);

    // the refused try changed nothing: the password of the first save still signs in
    const signedIn = await asSite('/v1/auth/login', {
      body: { email: user.email, password: first },
    });
    expect(signedIn.status, 'the password of the first save signs in').toBe(200);
  });

  test('a signed-in browser that opens a link sees the reset screen, and after saving, its own session is gone (reload shows sign-in)', async ({
    page,
  }) => {
    const user = await makeSettledUser('signedin');
    const chosen = newPassword();

    // signed in as the login, in this browser
    await page.goto('/');
    await expect(page.getByLabel('Email')).toBeVisible();
    await signInOnScreen(page, user, user.password);
    expect(await meStatus(page), 'me while signed in').toBe(200);

    // the link of the mail, opened in the same browser: the reset screen and not the application
    const link = await linkFor(user.email);
    await openLink(page, link);
    await expect(aside(page)).toHaveCount(0);

    // Save: the store asks `me` at once, and the answer is 401 because every session of the login has ended. The 8-second poll is not what finds it out.
    const lost = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/v1/auth/me' && response.status() === 401,
      { timeout: 5_000 }
    );
    await saveNewPassword(page, chosen);
    await expect(page.getByText(CHANGED_WORDS, { exact: true })).toBeVisible();
    await lost;

    // the way on is the sign-in screen, now and after a reload
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(aside(page)).toHaveCount(0);
    expect(await meStatus(page), 'me after the reset').toBe(401);
  });
});
