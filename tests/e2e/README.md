# End-to-end tests

Playwright tests go in this folder (`playwright.config.ts` points here). No browser is downloaded by `npm install`: run `npx playwright install chromium` once (about 170 MB, into your own cache).

They run in a real browser against a **lane**: a throw-away MariaDB 11.8 container, the API built from a checkout of `jewelvault-api`, and **four logins** made through the API's admin door (an owner, a biller, a staff user and the Super Admin). The site is the Next.js dev server that Playwright starts itself.

```bash
# both are yours: your lane (main, a, b or c) and the checkout of jewelvault-api whose `main` the orchestrator keeps merged
export LANE=b
export JV_API_DIR=../jewelvault-api-wt/b

E2E=1 npx playwright test tests/e2e/harness.spec.ts   # one spec (PT-W0)
E2E=1 npm run test:e2e                                # all of them
E2E=1 npm run verify                                  # typecheck, changed-file lint, unit, build, build check, then these
```

Nothing starts without `E2E=1`: a lane starts Docker containers and servers on this computer, so it is asked for on purpose. `npm run verify` without it runs everything else and skips this step by name.

## What the global setup does

`tests/e2e/global-setup.ts` calls `laneUp` of `scripts/e2e-lane.mjs`, which

1. runs the API repository's own lane tool, `npm run db:lane -- up <lane>` (container `jv-mariadb-<lane>`, data in tmpfs, no Docker volume, the ten-box user of A3, migrations and seeds); a container that already exists is emptied first, so every run starts on a clean database;
2. compiles the API (`tsconfig.build.json`) into `node_modules/.cache/jv-e2e/<lane>/dist` of `JV_API_DIR` (git ignores it; two lanes never delete each other's build);
3. starts it on the lane's API port with `ALLOWED_ORIGINS` set to the site's origin, `JV_ADMIN_TOKEN_HASH` set to the hash of a token made for this run, and the lane database's password (read from Docker in memory, never printed or written);
4. runs `npm run admin -- add-user` three times (owner, biller, staff) and then `npm run admin -- make-super-admin` once, signs each of the four in with the temporary password and changes it, so the logins are ordinary ones (no must-change gate). The Super Admin is made the way Harsh makes Siddhi: a login with the role `owner` and the Super Admin flag, which is what opens People & Roles. It has an e-mail address of its own (`e2e-super-<run>@jv-test.local`), never the owner's, and it is made after the other three on a clean database: the door allows only one active Super Admin, so the lane has exactly one;
5. writes their e-mail addresses and passwords and the admin token to `.lanes/<lane>/.env.local` (mode 0600, git-ignored), and puts them in `process.env` for the tests (`JV_E2E_OWNER_*`, `JV_E2E_BILLER_*`, `JV_E2E_STAFF_*` and `JV_E2E_SUPER_*`).

The API of a lane sends no real mail: it starts with the **outbox mailer** (`JV_MAIL_OUTBOX_DIR`, `JV_MAIL_FROM`, `JV_RESET_LINK_BASE=<site origin>/reset-password`), which writes each mail as `<ISO time>-<12 hex>.json` (`{ to, subject, text, html }`) into `.lanes/<lane>/outbox`, emptied at every `up`. The folder reaches the tests as `JV_E2E_OUTBOX` (`e2eOutbox()` in `global-setup.ts`); `forgot-password.spec.ts` reads the reset link from the `text` of the newest file for its login. The API limits forgot-password asks in memory (3 an hour for one e-mail, 10 an hour from one address; the page and the test process send no `x-real-ip`, so all asks of a run share one address), so a spec makes a login of its own for each link it needs and keeps the asks of the whole run under 10.

After the last test (or a failed one, or Ctrl-C) the teardown stops the API and removes the container with `docker rm -fv`. After a killed run, `npm run e2e:lane -- down` (with `LANE` and `JV_API_DIR`) cleans up; the next run also does it first. `npm run e2e:lane -- up | down | status | ports` does the same by hand, for example to `npm run admin` against a lane or to look at one.

## Ports

The site listens on `PORT`, else on the lane's port (main 4028, a 4128, b 4228, c 4328), else 4028. The API listens on the next port (4029, 4129, 4229, 4329). The site is started with `NEXT_PUBLIC_API_URL` set to the lane's API (the only build-time variable, H4). Playwright never reuses a server that is already on the port.

**One run per checkout at a time.** `next dev` keeps one server per project folder (`.next/dev/lock`), so a second `E2E=1 npx playwright test` in the same worktree stops with "Another next dev server is already running". Two lanes at the same time need two worktrees, which is how the agents work; the lane stacks themselves (container, API, users, ports) do not collide.

## Writing a test

```ts
import { e2eLane, e2eLogin } from './global-setup';

const owner = e2eLogin('owner'); // { email, password, fullName }; also 'biller', 'staff' and 'super' (the Super Admin)
const { apiUrl, webOrigin, adminToken } = e2eLane();
```

- **Mail** is read from the lane's outbox, never from a mail server: `e2eOutbox()` is the folder (see above). `typeSecret` (`tests/e2e/secret.ts`) types a password with the keyboard, which keeps it out of the call log; a spec that reads a reset link never prints the mail's text (it holds the link) and checks it with a true or false.
- A call from a page to the API needs `credentials: 'include'` and, on every POST, PUT or PATCH, the header `X-JV-Client: web`; the browser adds the `Origin` of the site, which the API allows. A call that takes no body must send none: an empty body with `Content-Type: application/json` is a 422.
- The session cookie `__Host-jv_session` is `Secure; HttpOnly; SameSite=Strict`. Chromium keeps it on `http://localhost` and sends it back, so a test needs no workaround; `harness.spec.ts` asserts it.
- A test that needs a user of its own (a must-change user, a deactivated one) makes it through the admin door with `adminToken`: `POST {apiUrl}/admin/v1/users` with `Authorization: Bearer <token>` and no `Origin` header, so from the test process and not from the page.
- Specs run one at a time (`workers: 1`) on one database: a spec that changes shared data puts it back or makes its own.
- **The Super Admin** is `e2eLogin('super')`, the fourth login of the lane. Its password comes from `process.env` and is typed into the form field of the login screen: a test never prints it, never puts it in a title, a screenshot name or a log line. It is not a role: `ROLES` and `E2eRole` stay the three built-in roles (their keys are what `add-user` takes), and `LOGINS` and `E2eLoginName` list all four. The lane has exactly one Super Admin (the door refuses a second while one is active), so a test that needs a second one has no way to make it; a test that needs another person makes an ordinary login through the admin door as above, or, to test People & Roles itself, through the People tab (`+ Add person`: `people-roles.spec.ts` does, and reads the temporary password from the dialog that shows it once; it is typed with the keyboard and never printed).
- A write of the Super Admin (`/v1/super/*` except the three reads) carries the Super Admin's own password in its body, and five wrong passwords in a row pause that login for 15 minutes on the lane: a test that makes the pause happen must be the last one that signs in as the Super Admin.
- Nothing of People & Roles is ever deleted (roles and people are switched off, S7), so a role or a person a test makes stays in the lane until the lane is taken down, and the specs that run after it see it in the lists. In `people-roles.spec.ts` the specs of part 2 (a person added, P6 in both its phases, P8, the phone, the Activity Log) and the spec of the final wave (a role switched off while Add person is open) put `RUN`, made when the file is loaded, into the name of every role and person they make, so that a retry (`CI=1` retries twice, each retry in a new worker) never meets a name that is taken. The specs of part 1 (the Cashier of the second spec, the stale save's "Stale probe") and the one of Task 24b ("Switch probe") use fixed names and WOULD clash on a retry: the local runs have none. Do not assume that the People tab lists only the four logins of the lane: the specs that run before it (`login.spec.ts`) make users of their own.
- **Where a typed password still ends up.** `typeSecret` types with the keyboard, which keeps a password out of the call log of a failed action (`fill` and `type` write their text there). It does not keep it out of every file: the HTML reporter, which `playwright.config.ts` always turns on, records `page.keyboard.type(secret)` as a step titled `Type "<secret>"` in `playwright-report/`, even for a test that passes; `trace: 'on-first-retry'` (CI only) stores typed text in its trace; and `error-context.md` in `test-results/` holds the visible text of the page when a test fails (the temporary password dialog, while it is on screen), with no switch to turn that off. All of these folders are git-ignored and hold throw-away lane passwords, made for one run and gone with its lane. `--reporter=line` (or `--reporter=line,json`) leaves the HTML report out. So that a failing assertion does not print a password to the console either, a spec never asserts on the temporary password dialog as a whole (`toContainText`) or on the element that holds the password (`toBeVisible`): both print what they found. It asserts on the elements that hold the sentences (`getByText`, a heading) and counts the password's element (`toHaveCount`).

`harness.spec.ts` is PT-W0: the lane is up, a page of the site logs in as each role and reads `me`, the cookie is kept and sent, a logout ends the session, and a wrong password is refused. The Supabase-era `login.spec.ts` was removed together with the Supabase global setup it depended on; WEB02 writes the new one for the real login screen.

The PDF files of the saved estimate and of the Stock Catalogue (Download PDF and Share): `PDF-S1` is at the end of `print.spec.ts`, `PDF-S2` at the end of `stock-catalogue.spec.ts`; both use `pdf-file.ts` (the share stub and the saved file), and the PDF is read back with `tests/unit/support/pdf-read.ts`.
