# The test harness (task DB01)

Everything an agent needs to run and write tests for the JewelVault backend. The spec is in `specs/p1-foundation-and-money/`
(section 15 lists the tests, section 10 the functions); the plan (`plan.md` section 1) explains why the harness looks like this.

## 1. One stack per agent: lanes

A Supabase stack is five Docker containers (database, auth, api gateway, rest, storage; about 350 MB). Two stacks with the
same project id or the same ports cannot run together, and one agent's `db reset` would wipe another's data, so every agent
has its own **lane**:

| Lane   | Whose                         | Project id | API / database port | Dev-server port |
| ------ | ----------------------------- | ---------- | ------------------- | --------------- |
| `main` | the orchestrator, on `main`   | `jv-main`  | 44321 / 44322       | 4028            |
| `a`    | agent A (database)            | `jv-a`     | 45321 / 45322       | 4128            |
| `b`    | agent B (front end)           | `jv-b`     | 46321 / 46322       | 4228            |
| `c`    | agent C (side tasks, reviews) | `jv-c`     | 47321 / 47322       | 4328            |

The blocks are 443xx, 453xx, 463xx and 473xx: valid ports below 49152, where macOS starts handing out its own, and clear of
the default Supabase block 543xx that Harsh's other project uses on this Mac. `npm run lane -- ports` shows the plan and
whether each lane's ports are free. **Use only your own lane.** Never run `docker system prune`, `docker volume prune` or
`supabase stop --all`, and never touch a container, volume or image that is not yours.

`LANE` is required for every database command (there is no default, so nobody ends up on the wrong stack by forgetting it):

```bash
LANE=a npm run db:start          # starts the stack (about 30 s once the images are cached) and writes .lanes/a/.env.local
LANE=a npm run db:stop           # stops it, keeps its data
LANE=a npm run db:stop -- --no-backup   # stops it and deletes its Docker volumes (only when you mean it)
LANE=a npm run db:reset          # empty database + migrations + seeds   (supabase db reset --local)
LANE=a npm run db:test           # reset, then the pgTAP tests            (supabase test db neither migrates nor seeds)
LANE=a npm run db:test:2         # the Vitest tests over two connections and over HTTP
LANE=a npm run db:check          # T-F04: migrations applied twice give the same schema, the advisor is clean
LANE=a npm run verify            # every gate; run it before anything is called ready to push
LANE=a npm run lane -- psql      # psql inside your database container   (also: status, env, run, ports, help)
```

`scripts/lane.mjs` writes `.lanes/<lane>/` (never committed): the committed `supabase/config.toml` with the lane's project id
and ports, links to `supabase/migrations`, `supabase/tests` and `supabase/seeds`, the lane's `.env.local` and the logs of
`verify`. It also writes `.env.local` at the top of the repository (API URL, publishable key, local database URL, `PORT`) unless
a file there was not written by the tool. A worktree normally runs one lane; if you start two from one worktree, the file at
the top follows the last one, so use `LANE=a npm run lane -- run <command>` to run a command with exactly one lane's settings
(for example `npm run dev`, which listens on that lane's `PORT`, or `npx playwright test`).

Docker hygiene: compare `docker volume ls -q | wc -l` before and after your work. `db:stop` keeps a lane's two volumes;
`db:stop -- --no-backup` removes them. `npm run lane -- status` prints the count.

## 2. The suites

| Suite                   | Command                                | Where                                | What it is for                                                                                  |
| ----------------------- | -------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| pgTAP                   | `npm run db:test`                      | `supabase/tests/database/*.test.sql` | single-session database tests, each in a transaction that is rolled back (type DB)              |
| Vitest, two connections | `npm run db:test:2`                    | `tests/db/*.test.ts`                 | locks, concurrency, parity, HTTP, anything that must commit (type DB2); files run one at a time |
| Vitest, unit            | `npm test`                             | `tests/unit/*.test.ts`               | code with no database, including this harness's own tool                                        |
| Playwright              | `npx playwright test` through the lane | `tests/e2e`                          | browser tests; `workers: 1`, `fullyParallel: false`, port from `PORT`                           |
| Migration check         | `npm run db:check`                     | `scripts/check-migrations.sh`        | T-F04 (see section 6)                                                                           |
| Everything              | `npm run verify`                       |                                      | see section 7                                                                                   |

Every test is written first and seen to fail for the right reason, then the code is written (Playbook 3.3). Write the name
of the spec test (`T-C09`) in the file header.

## 3. pgTAP and the `tests` helpers

Seeds run only on a local stack, after the migrations: `supabase/seeds/00_guard.sql` stops them on anything that is not a
local stack, and `10_test_helpers.sql` makes the `tests` schema. **After you change a seed file, run `db:reset`** (`db:test`
resets for you). The helpers run with the caller's rights, pin their `search_path` and are executable by the database owner
only, except the three role switches.

```sql
begin;
select plan(3);
do $$ begin perform set_config('jv.biller', tests.make_user('biller')::text, true); end $$;  -- keep ids in a setting
select tests.as_user(current_setting('jv.biller')::uuid);           -- from here on: role authenticated, auth.uid() set
select is(auth.uid(), current_setting('jv.biller')::uuid, 'the request is the biller');
select tests.reset_role();                                          -- back to postgres
select * from finish();
rollback;
```

| Helper                                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests.make_user(role, email, full_name)`                                           | A login: an `auth.users` row with every token column set and its email identity. `role` is `owner`, `biller`, `staff` (active profile), `inactive` (the new-user trigger's profile) or `none` (no profile). Returns the id. Profiles and `private.activate_user` are used once they exist (DB02).                                                                                                                                                                                          |
| `tests.as_user(uuid)`, `as_anon()`, `reset_role()`                                  | Become a signed-in user, anon, or postgres again. Local to the transaction; callable while signed in.                                                                                                                                                                                                                                                                                                                                                                                      |
| `tests.set_clock(ts, fn)`                                                           | Replaces `private.now_ts()` (or another zero-argument `timestamptz` function) by one that returns `ts`, inside your transaction, so it is rolled back and no other session sees it. Call it before `as_user`.                                                                                                                                                                                                                                                                              |
| `tests.insert_row(table, json)`                                                     | One row from a JSON object; a column left out takes its default; an unknown column is an error. Returns the row.                                                                                                                                                                                                                                                                                                                                                                           |
| `tests.make_category / make_design / make_piece / make_customer / make_rate (json)` | Fixture builders with defaults from the spec (D4 to D7, D10); the JSON overrides them. Return the new id. `make_piece(design, json)` makes a design when it gets none. There is no bill builder yet: it is added with `create_bill` (DB09b).                                                                                                                                                                                                                                               |
| `tests.bulk_rows(table, count, template, refs)`                                     | `count` rows in one statement from a JSON template. In a string: `{n}` is the row number, `{n:5}` the number padded to 5 digits, `{ref:public.designs}` an existing id of that table taken in turn. 1,500 rows take 30 ms.                                                                                                                                                                                                                                                                 |
| `tests.bulk_pieces(2500)`, `tests.bulk_bills(3000)`                                 | The sizes of T-F03 and C2, built on `bulk_rows` (a quarter of a second each).                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tests.reset_business_data(keep_users, lock_timeout)`                               | For tests that had to commit: ends sessions of the same user that are idle inside a transaction, truncates every table of `public` and `private` found in the catalogue (except `private.limits` and extension tables), deletes the profiles and then the logins (not with `keep_users`), calls `private.seed_defaults()` once it exists, all under `lock_timeout` (default 10 s) so it fails instead of hanging. Storage objects and buckets are not touched; DB07 adds a block for them. |

**Catalogue tests skip the `tests` schema.** A test that walks every function in the catalogue (T-D09, T-D16: who may execute
what) must leave out `tests`: its three role switches are executable by `anon` and `authenticated` on purpose, so that a test
can change user while signed in. The schema exists only on a local stack (the guard refuses anything else) and the API does
not expose it (`api.schemas = ["public"]`, checked in `rpc.test.ts`).

**Trap:** a builder called inside a query that also scans the table it fills does not see its own row (a function in a
`WHERE` runs per row). Call builders in a `do` block or a plain `select`, keep the ids in a setting, then assert.

**The builders are written from the spec's column lists, not from real tables, because those do not exist yet.**
`000_smoke.test.sql` builds a small stand-in for each missing table (`profiles`, `categories`, `designs`, `skus`, `customers`,
`daily_rates`, `bills`) inside its transaction, so the helpers are exercised now; once the real table exists the same
assertions run against it. The task that creates a table (DB03 stock and rates, DB04 customers and bills, DB02 profiles)
is the first to run its builder for real: if a builder no longer fits the schema, fix it in your own block of
`10_test_helpers.sql` (see section 5) and say so in your report.

## 4. Two connections, the hook, and HTTP

`tests/db/pg.ts`

- `connect(label)` is a session named `jv-test:<label>` with a 60 s statement timeout; `twoConnections()` gives `a` and `b`.
- `beginAs(client, { role, userId })` and `withRole(client, ctx, fn, { commit })` run as a request arrives: `set local role`
  plus the JWT claims. `beginAs` keeps the transaction open for a second connection to be tested against.
- `waitUntilBlocked(observer, pid)` returns the backends `pid` waits for, polling instead of sleeping; `waitEvent(observer, pid)`
  says what it waits on (`advisory`, `transactionid`, `tuple` ...); `backendPid(client)` works while the session is busy.
- A test that commits cleans up after itself (`tests.reset_business_data()`, or drop what it made) and uses names that cannot
  meet a real row. Waits use these helpers or the lock timeout, never a fixed sleep.

`tests/db/hook.ts` is the test hook of X0 item 8 and the negative control behind T-C09 to T-C14. Every money function calls
`private.test_pause('<function>.after_read')` after it has read the customer's state and before it allocates (in production
that function is empty). A two-session test holds each session at the point with a gate of its own, and lets them go in either
order. `a` and `b` are `connect('a')` and `connect('b')`, `admin` is the controlling session (it holds the gates):

```ts
import { RELEASE_ORDERS, dropClause, inReleaseOrder, withHook, withMutation } from './hook';
import type { ReleaseOrder } from './hook';

async function twoPayments(order: ReleaseOrder) {
  // withHook replaces private.test_pause once, committed; the original is back when the block ends, whatever happens
  await withHook(admin, async (hook) => {
    const g1 = await hook.gate('record_payment.after_read', a); // the gate of session 1 at this point
    const g2 = await hook.gate('record_payment.after_read', b); // the gate of session 2
    await g1.hold();
    await g2.hold();
    const first = hook.track(a.query('select ...')); // tracked: dispose waits for it, a failure is never "unhandled"
    await g1.waitUntilWaiting(admin); // session 1 is at the point, and holds the customer lock
    const second = hook.track(b.query('select ...'));
    // session 2 has to wait for the customer lock, not for its gate. Without the lock it is at its gate: this fails.
    expect(
      await g2.waitUntilHeldUp(admin),
      'session 2 must be held back by the customer lock, not by its own gate'
    ).toEqual({ by: 'lock', blockedBy: [g1.pid] });

    const [releasedFirst, releasedSecond] = inReleaseOrder(order, g1, g2);
    await releasedFirst.release();
    if (releasedFirst === g1) {
      await first; // session 1 finishes, and only then can session 2 reach the point
      await g2.waitUntilWaiting(admin); // where its own gate still holds it
    }
    await releasedSecond.release();
    await Promise.all([first, second]);
    /* assert the results, then tests.assert_i10 ... */
  });
}

describe.each(RELEASE_ORDERS)('T-C09 two payments (%s)', (order) => {
  it('with the customer lock', () => twoPayments(order));
  it('with the lock cut out the same test fails', async () => {
    await expect(
      withMutation(admin, 'public.record_payment(...)', dropClause(/for update/gi), () =>
        twoPayments(order)
      )
    ).rejects.toThrow(/customer lock/);
  });
});
```

- **One gate per session.** The replacement of `private.test_pause` is generic and is made once by `withHook` (or
  `installHook`, with `hook.dispose()` in a `finally`). It finds the caller's own gate by the point and the caller's
  `application_name` (`jv-test:<label>`), so two sessions held at one point are released independently
  (`g1.release()`, `g2.release()`), a session without a gate, or with an open one, passes straight through, and making more
  gates never touches the function. Give each session its own label; the controlling session cannot be gated. Make the gates
  before the sessions start their calls. A call over HTTP is never held: PostgREST connects under another name.
- **A polling wait under 5 seconds.** The writing functions run under `lock_timeout = '5s'`, which cuts a plain advisory wait
  with 55P03 (`JV_BUSY` in a money function). The replacement polls `pg_try_advisory_lock` for at most `HOOK_MAX_WAIT_MS`
  (4 s; the `maxWaitMs` option takes less, never 5000 or more) and then lets the call carry on, with a NOTICE. A gate left
  closed is therefore never a lock timeout, and neither is the wait of the session behind the one that is held.
- **Seeing who waits.** A polling session is not in a lock wait, so wait events show nothing. While it waits at a closed
  gate it holds a shared advisory lock of its own (a marker in `pg_locks`), which `gate.isWaiting(observer)`,
  `gate.waitUntilWaiting(observer)`, `hook.waiters(observer, point)` and `hook.waitForWaiters(observer, point, count)` read.
  `gate.waitUntilHeldUp(observer)` says where a session has come to rest: `{ by: 'gate' }`, or `{ by: 'lock', blockedBy: pids }`.
  The hook owns the advisory lock classes 71000 and 71001.
- **Both release orders.** `RELEASE_ORDERS` is `'session 1 first'` and `'session 2 first'`; `inReleaseOrder(order, x1, x2)`
  returns `[first, second]`. Write the scenario as a function of `order` and run it with `describe.each(RELEASE_ORDERS)`, the
  negative control included: with the lock removed, one order alone can pass (RM3-2).
- **Cleaning up.** `withHook` and `hook.dispose()` open every gate, wait for the calls registered with `hook.track(...)`, and put
  the original function back, also when the test fails. Finish your own open transactions (`beginAs`) before the block ends, or
  the tracked calls behind them keep `dispose` waiting. A replacement that was left behind (a run stopped half way) is refused
  by the next install with a message; `LANE=<lane> npm run db:reset` clears it.
- `createGate(controller, point, options)` of DB01 is gone. It replaced the function once per gate, so a second gate overwrote
  the first and every session at a point shared one lock; it is `installHook` / `withHook` plus `hook.gate(point, session)` now.

`mutateFunction` commits a changed copy of a function and returns the way back; it refuses a change that changes nothing, so a
negative control cannot pass for the wrong reason. `withMutation` does it for the length of a function, restoring whatever
happens. `tests/db/hook.test.ts` proves the machinery on a toy with the same shape as a writing function (a row lock, the hook
after the read, then the write, under `lock_timeout = '5s'`) and is the model for DB18a.

`tests/db/rpc.ts` makes a real login through the Auth admin API (`createLogin({ appRole })`, a random password that lives only
in memory) and calls functions over HTTP (`rpc(login, 'name', args)`), through the gateway, the JWT check, PostgREST and the
role's own settings: the way to see the role's statement timeout (8 s on the platform, 15 s after migration 0001). A function
created a moment ago is waited for in the schema cache. The secret key the admin API needs comes from the environment that
`db:test:2` sets up; it is never written to a file. `deleteLogin(id)` deletes the login's profile row over a database
connection first, because a login that has a profile cannot be deleted (`profiles.id` is `ON DELETE RESTRICT`, DB02); a test
that deletes a login by some other way does the same.

## 5. Adding to the shared files

`supabase/seeds/10_test_helpers.sql` and `package.json` are shared. Add your helpers as a block of your own after the last
one, between `-- ===== BEGIN <task> =====` and `-- ===== END <task> =====`, and touch nothing above. A helper is security
invoker, pins its `search_path` (advisor lint 0011 also reads the `tests` schema), and says which task creates what it needs
when that is missing. Migrations are never edited once merged: add a new one (`npx supabase migration new` in a lane gives the
timestamp version; the orchestrator renumbers at merge).

## 6. T-F04: the migrations (`npm run db:check`)

1. **The files** (S9): `<14 digit version>_<name>.sql`, versions unique, no empty file, every `create table` has its
   `alter table ... enable row level security` in the same file, and a migration that is already merged is never edited,
   deleted or renamed (checked against the merge base with `main`). `scripts/check-migrations.sh --static [dir]` runs this part
   with no Docker.
2. **Twice on an empty database:** reset without seeds, take a fingerprint, reset again, take another, compare. The
   fingerprint is the whole schema as `pg_dump` writes it (event triggers and default privileges included, which the CLI's
   own dump leaves out) plus role settings, storage buckets, cron jobs and extension versions.
3. **The advisor** (`supabase db advisors --local --level warn --fail-on warn`) must find nothing.

Dev and prod use these same files: there is one `supabase/migrations` folder, and no seed in it. Production gets the
migrations alone (D20); the seeds are local only and refuse to run anywhere else. After `db:check` the lane's database has no
seeds; `db:test` resets, and `db:test:2` resets by itself when the `tests` schema is missing.

## 7. `npm run verify`

Runs, in this order, and prints a table at the end (the full output is in `.lanes/<lane>/logs/`): typecheck, lint, unit,
`db:check`, `db:test`, `db:test:2`, build, build check, e2e. **Lint covers only the files changed since the merge base with
`main`** (committed, staged, unstaged and new), because the prototype's 1,221 existing findings are not this phase's to fix;
a file you touch must be clean. A step whose npm script does not exist yet is printed as `skipped (task X)` and named in the
report: today `build check` (FE06) and `e2e` (FE02). A task that adds one of those scripts makes the step run. `verify` starts
the lane's stack when it is not running.

## 8. When something goes wrong

- _port in use_: another program listens on a port of your lane; the message gives the `lsof` command. Do not stop a program
  that is not yours.
- _Docker is not running_: start Docker Desktop.
- _the tests schema is missing, or a helper is old_: `LANE=a npm run db:reset`.
- _a `postgres` command says permission denied_: the role is not a superuser in the Supabase image; changing the default
  privileges of, or dropping what is owned by, another role needs `grant that_role to postgres with inherit true, set true`.
- _`supabase test db` shows rows or NOTICE lines_: harmless; only `ok` / `not ok` lines count.
- _deleting a login fails with a foreign key error (23503, or a 500 from the Auth admin API)_: the login has a profile and
  `profiles.id` is `ON DELETE RESTRICT`. Deactivate the profile (`active = false`), or delete the profile row first and then
  the login (`tests.reset_business_data()` and `deleteLogin` in `tests/db/rpc.ts` already do).
- _a lane left behind after a `git revert` of DB01_: the scripts are gone with it, so stop the stack by hand:
  `npx supabase stop --no-backup --project-id jv-a` (and `jv-main`, `jv-b`, `jv-c` if they were started). Nothing outside the
  repository changes except these containers and their two volumes each.
