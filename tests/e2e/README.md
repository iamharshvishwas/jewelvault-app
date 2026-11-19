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

- A call from a page to the API needs `credentials: 'include'` and, on every POST, PUT or PATCH, the header `X-JV-Client: web`; the browser adds the `Origin` of the site, which the API allows. A call that takes no body must send none: an empty body with `Content-Type: application/json` is a 422.
- The session cookie `__Host-jv_session` is `Secure; HttpOnly; SameSite=Strict`. Chromium keeps it on `http://localhost` and sends it back, so a test needs no workaround; `harness.spec.ts` asserts it.
- A test that needs a user of its own (a must-change user, a deactivated one) makes it through the admin door with `adminToken`: `POST {apiUrl}/admin/v1/users` with `Authorization: Bearer <token>` and no `Origin` header, so from the test process and not from the page.
- Specs run one at a time (`workers: 1`) on one database: a spec that changes shared data puts it back or makes its own.
- **The Super Admin** is `e2eLogin('super')`, the fourth login of the lane. Its password comes from `process.env` and is typed into the form field of the login screen: a test never prints it, never puts it in a title, a screenshot name or a log line. It is not a role: `ROLES` and `E2eRole` stay the three built-in roles (their keys are what `add-user` takes), and `LOGINS` and `E2eLoginName` list all four. The lane has exactly one Super Admin (the door refuses a second while one is active), so a test that needs a second one has no way to make it; a test that needs another person makes an ordinary login through the admin door as above, or, to test People & Roles itself, through the People tab (`+ Add person`: `people-roles.spec.ts` does, and reads the temporary password from the dialog that shows it once; it is typed with the keyboard and never printed).
- A write of the Super Admin (`/v1/super/*` except the three reads) carries the Super Admin's own password in its body, and five wrong passwords in a row pause that login for 15 minutes on the lane: a test that makes the pause happen must be the last one that signs in as the Super Admin.
- Nothing of People & Roles is ever deleted (roles and people are switched off, S7), so a role or a person a test makes stays in the lane until the lane is taken down, and the specs that run after it see it in the lists. `people-roles.spec.ts` puts `RUN`, made when the file is loaded, into the name of everything it makes, so that a retry (`CI=1` retries twice, each retry in a new worker) never meets a name that is taken. Do not assume that the People tab lists only the four logins of the lane: the specs that run before it (`login.spec.ts`) make users of their own.

`harness.spec.ts` is PT-W0: the lane is up, a page of the site logs in as each role and reads `me`, the cookie is kept and sent, a logout ends the session, and a wrong password is refused. The Supabase-era `login.spec.ts` was removed together with the Supabase global setup it depended on; WEB02 writes the new one for the real login screen.
