import type { Client, QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PAUSE_FN,
  FUNCTION_LOCK_TIMEOUT_MS,
  HOOK_MAX_WAIT_MS,
  RELEASE_ORDERS,
  dropClause,
  getFunctionDef,
  inReleaseOrder,
  installHook,
  mutateFunction,
  withHook,
  withMutation,
  type Hook,
  type ReleaseOrder,
} from './hook';
import { backendPid, connect, twoConnections, waitEvent } from './pg';

// PT-H1 (hook machinery) and the part of T-C09 to T-C14 that is the hook itself: one gate per session, a polling wait
// of less than 5 seconds, both release orders, and the same test failing when the customer lock is cut out. DB01, DB01b.
//
// The real writing functions do not exist yet, so the hook is proved on a toy that has the same shape as one: it locks a
// "customer" row, calls the hook after it has read, then writes, and it runs under lock_timeout = '5s' like the real
// functions (X0 item 7). The same scenario then runs against the toy with its lock cut out, and has to fail: this is
// what "with the customer lock removed the same test fails" means in the spec.

const PAUSE = 'jv_hook.test_pause';
const PAUSE_SIGNATURE = 'jv_hook.test_pause(text)';
const PAY = 'jv_hook.pay()';
const POINT = 'pay.after_read';
let admin: Client;
let a: Client;
let b: Client;
let closeBoth: () => Promise<void>;

beforeAll(async () => {
  admin = await connect('hook-admin');
  const pair = await twoConnections();
  a = pair.a;
  b = pair.b;
  closeBoth = pair.close;
  // The parameter is called p_name, like the real private.test_pause(name): create or replace cannot rename a parameter,
  // so every install below also proves that the replacement keeps the name of the function it replaces.
  await admin.query(`
    drop schema if exists jv_hook cascade;
    create schema jv_hook;
    create table jv_hook.cust (id int primary key, n int not null);
    create function jv_hook.test_pause(p_name text) returns void language plpgsql as $f$ begin null; end $f$;
    create function jv_hook.pay() returns int language plpgsql set lock_timeout = '5s' as $f$
    declare v int;
    begin
      select n into v from jv_hook.cust where id = 1 for update;
      perform jv_hook.test_pause('pay.after_read');
      update jv_hook.cust set n = v + 1 where id = 1;
      return v + 1;
    end $f$;
    create function jv_hook.other() returns int language plpgsql set lock_timeout = '5s' as $f$
    begin
      perform jv_hook.test_pause('other.point');
      return 1;
    end $f$;
  `);
});

beforeEach(async () => {
  await admin.query('truncate jv_hook.cust; insert into jv_hook.cust values (1, 0)');
});

afterEach(async () => {
  await admin.query('select pg_advisory_unlock_all()');
});

afterAll(async () => {
  await closeBoth?.();
  await admin?.query('drop schema if exists jv_hook cascade');
  await admin?.end();
});

const callPay = (client: Client) => client.query('select jv_hook.pay() as n');
const callOther = (client: Client) => client.query('select jv_hook.other() as n');
const counter = async () =>
  (await admin.query('select n from jv_hook.cust where id = 1')).rows[0].n as number;
const byNumber = (x: number, y: number) => x - y;

/**
 * The scenario of T-C09 as the real tests will have it: two payments for one customer, session 1 held at the hook and
 * session 2 released first or second. Every assertion is the one of a correct implementation, so that the same scenario
 * can be run against the function with its lock cut out and has to fail there.
 */
async function twoPayments(order: ReleaseOrder): Promise<void> {
  await withHook(
    admin,
    async (hook) => {
      const g1 = await hook.gate(POINT, a);
      const g2 = await hook.gate(POINT, b);
      await g1.hold();
      await g2.hold();
      const first = hook.track(callPay(a));
      await g1.waitUntilWaiting(admin); // session 1 is at the point, and holds the row lock
      const second = hook.track(callPay(b));
      expect(
        await g2.waitUntilHeldUp(admin),
        'session 2 must be held back by the customer lock, not by its own gate'
      ).toEqual({ by: 'lock', blockedBy: [g1.pid] });

      const [releasedFirst, releasedSecond] = inReleaseOrder(order, g1, g2);
      await releasedFirst.release();
      if (releasedFirst === g1) {
        // session 1 goes on and finishes; only then can session 2 reach the point, where its own gate still holds it
        expect((await first).rows[0].n).toBe(1);
        await g2.waitUntilWaiting(admin);
      } else {
        // the gate of session 2 is open already, but session 2 still waits for the row lock behind session 1
        expect(await g2.waitUntilHeldUp(admin)).toEqual({ by: 'lock', blockedBy: [g1.pid] });
      }
      await releasedSecond.release();
      expect((await first).rows[0].n).toBe(1);
      expect((await second).rows[0].n).toBe(2);
      expect(await counter()).toBe(2);
    },
    { fn: PAUSE }
  );
}

describe('constants and helpers', () => {
  it('names private.test_pause as the default hook', () => {
    expect(DEFAULT_PAUSE_FN).toBe('private.test_pause');
  });

  it('dropClause removes a clause from a function definition', () => {
    expect(dropClause(/for update/gi)('select 1 from t for update; select 2 FOR UPDATE;')).toBe(
      'select 1 from t ; select 2 ;'
    );
  });

  it('keeps the wait of the hook under the lock_timeout of the writing functions', () => {
    expect(FUNCTION_LOCK_TIMEOUT_MS).toBe(5000);
    expect(HOOK_MAX_WAIT_MS).toBeGreaterThan(0);
    expect(HOOK_MAX_WAIT_MS).toBeLessThan(FUNCTION_LOCK_TIMEOUT_MS);
  });

  it('refuses a limit of 5 seconds or more, which the lock_timeout of 5 s would cut', async () => {
    const before = await getFunctionDef(admin, PAUSE_SIGNATURE);
    const installed: Hook[] = []; // only filled if a bad limit is accepted by mistake, so that it cannot leak
    try {
      for (const maxWaitMs of [FUNCTION_LOCK_TIMEOUT_MS, 60_000, 0, -1, 1.5]) {
        const attempt = installHook(admin, { fn: PAUSE, maxWaitMs }).then((hook) => {
          installed.push(hook);
          return hook;
        });
        await expect(attempt).rejects.toThrow(/whole number of milliseconds/);
      }
    } finally {
      for (const hook of installed) await hook.dispose();
    }
    expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toBe(before);
  });

  it('puts two things in the order they are released', () => {
    expect(RELEASE_ORDERS).toEqual(['session 1 first', 'session 2 first']);
    expect(inReleaseOrder('session 1 first', 'one', 'two')).toEqual(['one', 'two']);
    expect(inReleaseOrder('session 2 first', 'one', 'two')).toEqual(['two', 'one']);
  });
});

describe('the hook and one session', () => {
  it('holds the session at its point in plain sight, and lets it through when the gate is released', async () => {
    await withHook(
      admin,
      async (hook) => {
        const gate = await hook.gate(POINT, a);
        expect(gate.session).toBe('jv-test:a');
        expect(gate.pid).toBe(await backendPid(a));
        await gate.hold();
        const call = hook.track(callPay(a));
        await gate.waitUntilWaiting(admin);
        expect(await hook.waiters(admin, POINT)).toEqual([gate.pid]);
        // the session polls, it does not wait for a lock: nothing blocks it, and the marker is what shows it
        const { rows } = await admin.query('select pg_blocking_pids($1) as blockers', [gate.pid]);
        expect(rows[0].blockers).toEqual([]);
        expect((await waitEvent(admin, gate.pid)).type).not.toBe('Lock');
        await gate.release();
        expect((await call).rows[0].n).toBe(1);
        expect(await hook.waiters(admin, POINT)).toEqual([]);
      },
      { fn: PAUSE }
    );
  });

  it('lets a call at another point straight through', async () => {
    await withHook(
      admin,
      async (hook) => {
        const gate = await hook.gate(POINT, a);
        await gate.hold();
        expect((await callOther(a)).rows[0].n).toBe(1);
        expect(await hook.waiters(admin, POINT)).toEqual([]);
      },
      { fn: PAUSE }
    );
  });

  it('lets a session without a gate straight through while the gate of another session is closed', async () => {
    await withHook(
      admin,
      async (hook) => {
        const gate = await hook.gate(POINT, a);
        await gate.hold();
        const started = Date.now();
        expect((await callPay(b)).rows[0].n).toBe(1); // b has no gate
        expect(Date.now() - started).toBeLessThan(HOOK_MAX_WAIT_MS / 2);
        expect(await hook.waiters(admin, POINT)).toEqual([]);
      },
      { fn: PAUSE }
    );
  });

  it('lets later calls through once the gate is open, and holds again when it is closed again', async () => {
    await withHook(
      admin,
      async (hook) => {
        const gate = await hook.gate(POINT, a);
        await gate.hold();
        const first = hook.track(callPay(a));
        await gate.waitUntilWaiting(admin);
        await gate.release();
        expect((await first).rows[0].n).toBe(1);
        const started = Date.now();
        expect((await callPay(a)).rows[0].n).toBe(2); // the gate is open: no wait
        expect(Date.now() - started).toBeLessThan(HOOK_MAX_WAIT_MS / 2);
        await gate.hold();
        const third = hook.track(callPay(a));
        await gate.waitUntilWaiting(admin);
        await gate.release();
        expect((await third).rows[0].n).toBe(3);
      },
      { fn: PAUSE }
    );
  });

  it('is committed once: making more gates never touches the function', async () => {
    await withHook(
      admin,
      async (hook) => {
        const installed = await getFunctionDef(admin, PAUSE_SIGNATURE);
        const g1 = await hook.gate(POINT, a);
        const g2 = await hook.gate(POINT, b);
        const g3 = await hook.gate('other.point', a);
        expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toBe(installed);
        expect(await hook.gate(POINT, a)).toBe(g1); // the same session at the same point is the same gate
        expect(new Set([g1, g2, g3]).size).toBe(3);
        expect(g2.pid).toBe(await backendPid(b));
      },
      { fn: PAUSE }
    );
  });

  it('keeps the parameter name of the function it replaces, which create or replace cannot change', async () => {
    const argumentsOf = async () =>
      (
        await admin.query('select pg_get_function_arguments(to_regprocedure($1)) as args', [
          PAUSE_SIGNATURE,
        ])
      ).rows[0].args as string;
    expect(await argumentsOf()).toBe('p_name text');
    await withHook(admin, async () => expect(await argumentsOf()).toBe('p_name text'), {
      fn: PAUSE,
    });
  });

  it('refuses two sessions that carry the same name, because they would share one gate', async () => {
    const twin = await connect('a'); // the same application_name as the session a
    try {
      await withHook(
        admin,
        async (hook) => {
          await hook.gate(POINT, a);
          await expect(hook.gate(POINT, twin)).rejects.toThrow(/jv-test:a/);
        },
        { fn: PAUSE }
      );
    } finally {
      await twin.end();
    }
  });

  it('refuses to gate the controlling session, which holds the gates itself', async () => {
    await withHook(
      admin,
      async (hook) => {
        await expect(hook.gate(POINT, admin)).rejects.toThrow(/controlling session/);
      },
      { fn: PAUSE }
    );
  });

  it('does not leave its marker behind when the held call is cancelled', async () => {
    await withHook(
      admin,
      async (hook) => {
        const gate = await hook.gate(POINT, a);
        await gate.hold();
        await a.query('set statement_timeout = 400');
        try {
          await expect(callPay(a)).rejects.toMatchObject({ code: '57014' });
        } finally {
          await a.query('set statement_timeout = 60000');
        }
        expect(await gate.isWaiting(admin)).toBe(false);
        expect(await hook.waiters(admin, POINT)).toEqual([]);
      },
      { fn: PAUSE }
    );
  });
});

describe.each(RELEASE_ORDERS)('two sessions at one point, one gate each: %s', (order) => {
  it('with the lock: either order gives the right result, and session 2 never reaches the point beside session 1', async () => {
    await twoPayments(order);
  });

  it('with the lock cut out the same scenario fails, because session 2 is not held back', async () => {
    const before = await getFunctionDef(admin, PAY);
    await expect(
      withMutation(admin, PAY, dropClause(/for update/gi), () => twoPayments(order))
    ).rejects.toThrow(/held back by the customer lock/);
    expect(await getFunctionDef(admin, PAY)).toBe(before);
    expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toContain('begin null; end');
  });

  it('with the lock cut out both sessions are held at the point, one gate each, and an update is lost', async () => {
    await withMutation(admin, PAY, dropClause(/for update/gi), async () => {
      await withHook(
        admin,
        async (hook) => {
          const g1 = await hook.gate(POINT, a);
          const g2 = await hook.gate(POINT, b);
          await g1.hold();
          await g2.hold();
          const first = hook.track(callPay(a));
          const second = hook.track(callPay(b));
          // nothing holds session 2 back but its own gate: both sessions read 0 and wait at the point
          const atPoint = await hook.waitForWaiters(admin, POINT, 2, { timeoutMs: 5000 });
          expect(atPoint).toEqual([g1.pid, g2.pid].sort(byNumber));
          expect(await g1.waitUntilHeldUp(admin)).toEqual({ by: 'gate' });
          expect(await g2.waitUntilHeldUp(admin)).toEqual({ by: 'gate' });

          const [releasedFirst, releasedSecond] = inReleaseOrder(order, g1, g2);
          await releasedFirst.release();
          await (releasedFirst === g1 ? first : second); // the released session finishes ...
          expect(await releasedSecond.isWaiting(admin)).toBe(true); // ... while the other is still held
          expect(await hook.waiters(admin, POINT)).toEqual([releasedSecond.pid]);
          await releasedSecond.release();
          await Promise.all([first, second]);
          // both read 0 before either wrote, so both wrote 1: with the lock the counter would be 2
          expect(await counter()).toBe(1);
        },
        { fn: PAUSE }
      );
    });
  });
});

describe.each(RELEASE_ORDERS)('two gates at two points work together: %s', (order) => {
  it('hold one session at each point and release them independently', async () => {
    await withHook(
      admin,
      async (hook) => {
        const g1 = await hook.gate(POINT, a);
        const g2 = await hook.gate('other.point', b);
        await g1.hold();
        await g2.hold();
        const first = hook.track(callPay(a));
        const second = hook.track(callOther(b));
        await Promise.all([g1.waitUntilWaiting(admin), g2.waitUntilWaiting(admin)]);
        expect(await hook.waiters(admin, POINT)).toEqual([g1.pid]);
        expect(await hook.waiters(admin, 'other.point')).toEqual([g2.pid]);

        const [releasedFirst, releasedSecond] = inReleaseOrder(order, g1, g2);
        await releasedFirst.release();
        await (releasedFirst === g1 ? first : second);
        expect(await releasedSecond.isWaiting(admin)).toBe(true); // the other gate was not touched
        await releasedSecond.release();
        expect((await first).rows[0].n).toBe(1);
        expect((await second).rows[0].n).toBe(1);
      },
      { fn: PAUSE }
    );
  });
});

describe('a gate left closed', () => {
  it('lets the caller continue after the limit of the hook: no lock timeout, no error', async () => {
    await withHook(
      admin,
      async (hook) => {
        expect(hook.maxWaitMs).toBe(HOOK_MAX_WAIT_MS);
        const gate = await hook.gate(POINT, a);
        await gate.hold();
        const notices: string[] = [];
        const onNotice = (notice: { message?: string }) => notices.push(notice.message ?? '');
        a.on('notice', onNotice);
        const started = Date.now();
        let result: QueryResult;
        try {
          // nobody releases the gate; jv_hook.pay() runs under lock_timeout = '5s', which would cut a plain advisory wait
          result = await hook.track(callPay(a));
        } finally {
          a.off('notice', onNotice);
        }
        const elapsed = Date.now() - started;
        expect(result.rows[0].n).toBe(1); // the function carried on and wrote
        expect(elapsed).toBeGreaterThanOrEqual(HOOK_MAX_WAIT_MS - 100); // it waited for the whole limit ...
        expect(elapsed).toBeLessThan(FUNCTION_LOCK_TIMEOUT_MS); // ... and gave up before the lock timeout
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatch(/jv-test:a.*pay\.after_read.*still closed after 4000 ms/);
        expect(await gate.isWaiting(admin)).toBe(false);
        expect(await counter()).toBe(1);
      },
      { fn: PAUSE }
    );
  });

  it('honours a shorter limit', async () => {
    await withHook(
      admin,
      async (hook) => {
        expect(hook.maxWaitMs).toBe(300);
        const gate = await hook.gate(POINT, a);
        await gate.hold();
        const started = Date.now();
        expect((await hook.track(callPay(a))).rows[0].n).toBe(1);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(300 - 50);
        expect(elapsed).toBeLessThan(2000);
      },
      { fn: PAUSE, maxWaitMs: 300 }
    );
  });
});

describe('the original hook is back', () => {
  it('after dispose', async () => {
    const before = await getFunctionDef(admin, PAUSE_SIGNATURE);
    const hook = await installHook(admin, { fn: PAUSE });
    expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).not.toBe(before);
    await hook.dispose();
    expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toBe(before);
    await hook.dispose(); // twice is harmless
    expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toBe(before);
    await expect(hook.gate(POINT, a)).rejects.toThrow(/disposed/);
  });

  it('after a test that fails: the held call is let go and has finished, the controller holds no gate, the hook is back', async () => {
    const before = await getFunctionDef(admin, PAUSE_SIGNATURE);
    const calls: Promise<QueryResult>[] = [];
    let finished = false;
    const started = Date.now();
    await expect(
      withHook(
        admin,
        async (hook) => {
          const gate = await hook.gate(POINT, a);
          await gate.hold();
          calls.push(
            hook.track(
              callPay(a).then((result) => {
                finished = true;
                return result;
              })
            )
          );
          await gate.waitUntilWaiting(admin);
          throw new Error('the test blew up');
        },
        { fn: PAUSE }
      )
    ).rejects.toThrow(/blew up/);
    expect(Date.now() - started).toBeLessThan(HOOK_MAX_WAIT_MS / 2); // the gate was opened, not waited out
    expect(finished).toBe(true); // dispose waited for the call it was told about
    expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toBe(before);
    expect((await calls[0]).rows[0].n).toBe(1);
    const held = await admin.query(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = $1",
      [await backendPid(admin)]
    );
    expect(held.rows[0].n).toBe(0);
  });

  it('refuses to be installed over a hook that was never disposed of, and leaves it as it was', async () => {
    const before = await getFunctionDef(admin, PAUSE_SIGNATURE);
    const first = await installHook(admin, { fn: PAUSE });
    try {
      const installed = await getFunctionDef(admin, PAUSE_SIGNATURE);
      await expect(installHook(admin, { fn: PAUSE })).rejects.toThrow(/never disposed of/);
      expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toBe(installed);
    } finally {
      await first.dispose();
    }
    expect(await getFunctionDef(admin, PAUSE_SIGNATURE)).toBe(before);
  });

  it('removes a hook function it had to create, because there was none', async () => {
    const exists = async () =>
      (
        await admin.query(
          "select to_regprocedure('jv_hook.pause_absent(text)') is not null as found"
        )
      ).rows[0].found as boolean;
    expect(await exists()).toBe(false);
    const hook = await installHook(admin, { fn: 'jv_hook.pause_absent' });
    expect(await exists()).toBe(true);
    await hook.dispose();
    expect(await exists()).toBe(false);
  });
});

describe('calls started through the hook', () => {
  it('a call that fails and that nobody awaits any more leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await withHook(
        admin,
        async (hook) => {
          hook.track(Promise.reject(new Error('nobody awaits this call')));
        },
        { fn: PAUSE }
      );
      await new Promise((resolve) => setTimeout(resolve, 50)); // Node reports an unhandled rejection a turn later
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('mutateFunction and restore', () => {
  it('returns a restore function that puts the committed definition back', async () => {
    const original = await getFunctionDef(admin, 'jv_hook.pay()');
    const restore = await mutateFunction(admin, 'jv_hook.pay()', dropClause(/for update/gi));
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).not.toBe(original);
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).not.toMatch(/for update/i);
    await restore();
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).toBe(original);
  });

  it('is visible to the other connection, because it is committed', async () => {
    const restore = await mutateFunction(admin, 'jv_hook.pay()', dropClause(/for update/gi));
    try {
      const { rows } = await b.query(
        "select pg_get_functiondef('jv_hook.pay()'::regprocedure) as d"
      );
      expect(rows[0].d).not.toMatch(/for update/i);
    } finally {
      await restore();
    }
  });

  it('refuses a mutation that changes nothing, because a test of nothing would pass for the wrong reason', async () => {
    await expect(mutateFunction(admin, 'jv_hook.pay()', (def) => def)).rejects.toThrow(
      /did not change/i
    );
    await expect(
      mutateFunction(admin, 'jv_hook.pay()', dropClause(/this text is not in the function/g))
    ).rejects.toThrow(/did not change/i);
  });

  it('restores the function even when the code under test throws', async () => {
    const original = await getFunctionDef(admin, 'jv_hook.pay()');
    await expect(
      withMutation(admin, 'jv_hook.pay()', dropClause(/for update/gi), async () => {
        throw new Error('the test blew up');
      })
    ).rejects.toThrow(/blew up/);
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).toBe(original);
  });

  it('refuses a function that does not exist', async () => {
    await expect(getFunctionDef(admin, 'jv_hook.nope()')).rejects.toThrow(/nope/);
  });
});
