import type { Client } from 'pg';
import { backendPid } from './pg';

// The test hook of spec X0 item 8, and the negative control behind T-C09 to T-C14.
//
// Every writing function calls private.test_pause('<function>.after_read') once, after it has read the customer's state
// and before it allocates; in production that function is empty. A two-session test replaces it, committed so that every
// session sees it (an uncommitted replacement is invisible to the second connection), and puts the original back after
// the sessions. installHook and withHook do that, once.
//
// One gate per session. The replacement is generic and is made once. A gate is an advisory lock that the controlling
// session holds, keyed by the point and by the application_name of the caller (connect(label) names a session
// jv-test:<label>), so the replacement finds the caller's own gate by itself. Two sessions held at the same point are
// released independently, a session without a gate (or with an open one) passes straight through, and making more gates
// never touches the function, so gates do not clobber each other.
//
// A polling wait. The writing functions run under SET lock_timeout = '5s' (X0 item 7), which cuts a plain advisory-lock
// wait with 55P03 (a money function turns that into JV_BUSY). The replacement polls pg_try_advisory_lock instead, for
// less than 5 seconds in total, and then lets the caller carry on. Under the limit, the session that waits behind the
// one held at the hook is not cut by its own lock_timeout either.
//
// A polling session is not in a lock wait, so wait events cannot show who is at the point. For as long as it waits, the
// replacement holds a shared advisory lock of its own (a marker, found in pg_locks), which waiters() and
// waitUntilWaiting() read. A plain wait on the customer row would not prove the lock, because the foreign key of the
// bill insert takes its own lock on the same row (X0 item 8), so a test does not stop at "session 2 waits":
// waitUntilHeldUp says where it is held up, and with the customer lock cut out that is its own gate.
//
// The same test must fail when the lock is removed. mutateFunction commits a changed copy of a function (for example
// with its `for update` cut out), returns the way back, and refuses a change that changes nothing, so a negative
// control can never pass for the wrong reason.

export const DEFAULT_PAUSE_FN = 'private.test_pause';

/** The writing functions are created with SET lock_timeout = '5s' (X0 item 7). */
export const FUNCTION_LOCK_TIMEOUT_MS = 5000;

/** How long the replacement waits at a closed gate before the call carries on. Under FUNCTION_LOCK_TIMEOUT_MS. */
export const HOOK_MAX_WAIT_MS = 4000;

// The hook's advisory locks, in the two-int form: gates (held by the controlling session) and markers (held by a
// waiting session, shared so that several sessions can wait at one point). Other tests keep off these two classes.
const GATE_CLASS = 71_000;
const MARKER_CLASS = 71_001;
// In the text of the replacement, so that a replacement nobody disposed of is recognised.
const HOOK_TAG = 'jv-test-hook:v2';
const POLL_SECONDS = 0.02;
// How long dispose waits for the calls a test started through the hook, once their gates are open.
const DISPOSE_WAIT_MS = 15_000;

/** A function that removes what matches from a function definition, for mutateFunction. */
export function dropClause(pattern: RegExp): (definition: string) => string {
  return (definition) => definition.replace(pattern, '');
}

/** The full CREATE OR REPLACE FUNCTION text of a function, from the catalogue. `signature` is like schema.name(args). */
export async function getFunctionDef(client: Client, signature: string): Promise<string> {
  const { rows } = await client.query(
    'select pg_get_functiondef(to_regprocedure($1)) as definition, to_regprocedure($1) is not null as found',
    [signature]
  );
  if (!rows[0].found) throw new Error(`function ${signature} does not exist`);
  return rows[0].definition as string;
}

/**
 * Commits a changed copy of a function and returns a function that puts the original back. The change is made by
 * `transform` on the catalogue text of the definition. Throws when the text did not change.
 */
export async function mutateFunction(
  client: Client,
  signature: string,
  transform: (definition: string) => string
): Promise<() => Promise<void>> {
  const original = await getFunctionDef(client, signature);
  const mutated = transform(original);
  if (mutated === original) {
    throw new Error(
      `the mutation of ${signature} did not change the function, so a test of it would prove nothing`
    );
  }
  await client.query(mutated);
  return async () => {
    await client.query(original);
  };
}

/** mutateFunction for the length of `work`; the function is restored whatever happens. */
export async function withMutation<T>(
  client: Client,
  signature: string,
  transform: (definition: string) => string,
  work: () => Promise<T>
): Promise<T> {
  const restore = await mutateFunction(client, signature, transform);
  try {
    return await work();
  } finally {
    await restore();
  }
}

// ------------------------------------------------------------------------------------------------ both release orders

/**
 * The two orders in which a two-session test lets its sessions go: session 1 is the one that reaches the hook first and
 * holds the customer lock, session 2 the one that comes after it. X0 item 8: the test runs in both orders, because one
 * order alone can pass without the lock (a negative control that detects the missing lock in one order only).
 *
 *   describe.each(RELEASE_ORDERS)('T-C09 two payments (%s)', (order) => { ... inReleaseOrder(order, g1, g2) ... });
 */
export type ReleaseOrder = 'session 1 first' | 'session 2 first';
export const RELEASE_ORDERS: readonly ReleaseOrder[] = ['session 1 first', 'session 2 first'];

/** Puts what belongs to session 1 and session 2 (gates, calls ...) in the order they are released: [first, second]. */
export function inReleaseOrder<T>(order: ReleaseOrder, session1: T, session2: T): [T, T] {
  return order === 'session 1 first' ? [session1, session2] : [session2, session1];
}

// ------------------------------------------------------------------------------------------------ the hook and its gates

export interface HookOptions {
  /** The hook function to replace. Default private.test_pause. */
  fn?: string;
  /**
   * How long the replacement waits at a closed gate before the call carries on, in whole milliseconds. Default
   * HOOK_MAX_WAIT_MS. It has to be under FUNCTION_LOCK_TIMEOUT_MS, so that a caller held at the hook never meets the
   * lock timeout, and neither does a session that waits behind it.
   */
  maxWaitMs?: number;
}

export interface WaitOptions {
  /** How long the test waits, in milliseconds. Default 10 s. */
  timeoutMs?: number;
}

/** Where a session that was just started has come to rest: at its gate, or waiting for a lock held by other backends. */
export type HeldUp = { by: 'gate' } | { by: 'lock'; blockedBy: number[] };

/** The gate of one session at one point. It is made open; hold() closes it. */
export interface Gate {
  readonly point: string;
  /** The application_name of the session: jv-test:<label>. */
  readonly session: string;
  /** The backend id of the session. */
  readonly pid: number;
  /** Closes the gate (in the controlling session): this session's calls of the point now wait. Does nothing if closed. */
  hold(): Promise<void>;
  /**
   * Opens the gate: a call that waits at the point carries on within a few milliseconds, and later calls of this
   * session pass straight through. Does nothing if open. Other sessions' gates are not touched.
   */
  release(): Promise<void>;
  /** True while this session waits at the point. */
  isWaiting(observer: Client): Promise<boolean>;
  /** Polls until this session waits at the point; throws, saying where it is, when it does not arrive in time. */
  waitUntilWaiting(observer: Client, options?: WaitOptions): Promise<void>;
  /**
   * Polls until this session has come to rest, and says where: at its gate, or waiting for a lock (and for which
   * backends). The second session of T-C09 to T-C13 has to be held up by the customer lock, not by its gate; when
   * the lock is cut out it is held up by its gate, and a test that checks for the lock fails at once.
   */
  waitUntilHeldUp(observer: Client, options?: WaitOptions): Promise<HeldUp>;
}

export interface Hook {
  readonly fn: string;
  readonly maxWaitMs: number;
  /**
   * The gate of `session` (a connection made by connect(label)) at `point`. Make the gates before the sessions start
   * their calls. A session is known by its application_name, so two sessions need two labels; the controlling session
   * cannot be gated.
   */
  gate(point: string, session: Client): Promise<Gate>;
  /**
   * Registers a call that a test started in a session (`hook.track(a.query(...))`) and returns it. dispose opens
   * every gate, waits for the registered calls to finish, and only then puts the original back, so that a test that
   * fails half way leaves no call running into the next test; a rejection of a call the test no longer awaits is
   * not reported as unhandled.
   */
  track<T>(call: Promise<T>): Promise<T>;
  /** The backend ids of the sessions that wait at `point` right now. */
  waiters(observer: Client, point: string): Promise<number[]>;
  /** Polls until `count` sessions wait at `point`; throws when they do not arrive in time. */
  waitForWaiters(
    observer: Client,
    point: string,
    count: number,
    options?: WaitOptions
  ): Promise<number[]>;
  /** Opens every gate, waits for the tracked calls, and puts the original hook function back. Twice is harmless. */
  dispose(): Promise<void>;
}

function replacementSql(fn: string, args: string, maxWaitMs: number): string {
  // $1 is the point, whatever the original called its parameter: create or replace cannot rename a parameter.
  return `
    create or replace function ${fn}(${args}) returns void language plpgsql as $jv_hook$
    -- ${HOOK_TAG}: put here by a test (tests/db/hook.ts), which puts the original back.
    declare
      v_gate int := hashtext(coalesce($1, '') || chr(31) || current_setting('application_name'));
      v_mark int := hashtext(coalesce($1, ''));
      v_deadline timestamptz;
    begin
      -- No gate for this session at this point, or an open one: pass straight through and leave nothing behind.
      if pg_try_advisory_lock(${GATE_CLASS}, v_gate) then
        perform pg_advisory_unlock(${GATE_CLASS}, v_gate);
        return;
      end if;
      -- A closed gate: show that this session waits (a shared marker), then poll. Polling is not a lock wait, so the
      -- lock_timeout of the calling function does not cut it; the limit is below that timeout.
      perform pg_advisory_lock_shared(${MARKER_CLASS}, v_mark);
      begin
        v_deadline := clock_timestamp() + interval '${maxWaitMs} milliseconds';
        loop
          if pg_try_advisory_lock(${GATE_CLASS}, v_gate) then
            perform pg_advisory_unlock(${GATE_CLASS}, v_gate);
            exit;
          end if;
          if clock_timestamp() >= v_deadline then
            raise notice 'jv-test hook: the gate of "%" at "%" was still closed after ${maxWaitMs} ms; the call carries on', current_setting('application_name'), $1;
            exit;
          end if;
          perform pg_sleep(${POLL_SECONDS});
        end loop;
      exception when others or query_canceled then
        -- a session lock is not released by the rollback of a cancelled call
        perform pg_advisory_unlock_shared(${MARKER_CLASS}, v_mark);
        raise;
      end;
      perform pg_advisory_unlock_shared(${MARKER_CLASS}, v_mark);
    end $jv_hook$;
  `;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a backend is doing, for the message of a wait that ran out of time. */
async function whereIs(observer: Client, pid: number): Promise<string> {
  const { rows } = await observer.query(
    `select state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocked_by
       from pg_stat_activity where pid = $1`,
    [pid]
  );
  return rows[0] ? JSON.stringify(rows[0]) : 'no such backend';
}

async function markerPids(observer: Client, point: string): Promise<number[]> {
  const { rows } = await observer.query(
    `select pid from pg_locks
      where locktype = 'advisory' and granted and objsubid = 2
        and classid = ${MARKER_CLASS} and objid = hashtext($1)::oid
      order by pid`,
    [point]
  );
  return rows.map((row) => row.pid as number);
}

async function settledWithin(calls: Promise<unknown>[], ms: number): Promise<boolean> {
  if (calls.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([Promise.allSettled(calls).then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replaces the hook function (committed) by the generic one that waits at the gate of the calling session, and returns
 * the Hook that makes gates and puts the original back. `controller` is the session that holds the gates, a plain
 * connection in autocommit; it must stay connected while a test needs a gate closed.
 */
export async function installHook(controller: Client, options: HookOptions = {}): Promise<Hook> {
  const fn = options.fn ?? DEFAULT_PAUSE_FN;
  const maxWaitMs = options.maxWaitMs ?? HOOK_MAX_WAIT_MS;
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs >= FUNCTION_LOCK_TIMEOUT_MS) {
    throw new Error(
      `the limit of the hook must be a whole number of milliseconds under ${FUNCTION_LOCK_TIMEOUT_MS} ` +
        `(the writing functions run under lock_timeout = '5s', X0 item 7), not ${maxWaitMs}`
    );
  }
  const signature = `${fn}(text)`;
  const found = (
    await controller.query('select to_regprocedure($1) is not null as found', [signature])
  ).rows[0].found as boolean;
  const original = found ? await getFunctionDef(controller, signature) : null;
  if (original?.includes(HOOK_TAG)) {
    throw new Error(
      `${fn} is still replaced by a test hook that was never disposed of (a test was stopped half way?), so the ` +
        'original is not known. Rebuild the lane database: LANE=<lane> npm run db:reset'
    );
  }
  const args = found
    ? ((
        await controller.query('select pg_get_function_arguments(to_regprocedure($1)) as args', [
          signature,
        ])
      ).rows[0].args as string)
    : 'p_point text';
  await controller.query(replacementSql(fn, args, maxWaitMs));

  const gates = new Map<string, Gate>();
  const tracked = new Set<Promise<unknown>>();
  let disposed = false;
  const assertLive = () => {
    if (disposed) throw new Error(`the hook ${fn} has been disposed of`);
  };

  const makeGate = (point: string, session: string, pid: number): Gate => {
    let closed = false;
    const keyParams = [GATE_CLASS, point, session];
    const isWaiting = async (observer: Client) => (await markerPids(observer, point)).includes(pid);
    return {
      point,
      session,
      pid,
      hold: async () => {
        assertLive();
        if (closed) return;
        closed = true; // first, so that two calls that are not awaited cannot take the lock twice
        try {
          await controller.query(
            'select pg_advisory_lock($1, hashtext($2::text || chr(31) || $3::text))',
            keyParams
          );
        } catch (error) {
          closed = false;
          throw error;
        }
      },
      release: async () => {
        if (!closed) return;
        closed = false;
        await controller.query(
          'select pg_advisory_unlock($1, hashtext($2::text || chr(31) || $3::text))',
          keyParams
        );
      },
      isWaiting,
      waitUntilWaiting: async (observer, opts = {}) => {
        const timeoutMs = opts.timeoutMs ?? 10_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (await isWaiting(observer)) return;
          if (Date.now() >= deadline) {
            throw new Error(
              `${session} (backend ${pid}) did not reach the point "${point}" within ${timeoutMs} ms ` +
                `(${await whereIs(observer, pid)})`
            );
          }
          await sleep(25);
        }
      },
      waitUntilHeldUp: async (observer, opts = {}) => {
        const timeoutMs = opts.timeoutMs ?? 10_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (await isWaiting(observer)) return { by: 'gate' };
          const { rows } = await observer.query('select pg_blocking_pids($1) as blockers', [pid]);
          if (rows[0].blockers.length > 0) return { by: 'lock', blockedBy: rows[0].blockers };
          if (Date.now() >= deadline) {
            throw new Error(
              `${session} (backend ${pid}) was held up neither at "${point}" nor by a lock within ${timeoutMs} ms ` +
                `(${await whereIs(observer, pid)})`
            );
          }
          await sleep(25);
        }
      },
    };
  };

  const waiters = (observer: Client, point: string) => markerPids(observer, point);

  return {
    fn,
    maxWaitMs,
    gate: async (point, session) => {
      assertLive();
      if (session === controller) {
        throw new Error(
          'the controlling session cannot be gated, because it holds the gates itself: gate a session made with connect(label)'
        );
      }
      const pid = await backendPid(session);
      const { rows } = await controller.query(
        'select application_name as name from pg_stat_activity where pid = $1',
        [pid]
      );
      const name = (rows[0]?.name ?? '') as string;
      if (!name) {
        throw new Error(
          `backend ${pid} has no application_name: make the session with connect(label), so that its gate is found by name`
        );
      }
      for (const known of gates.values()) {
        if (known.pid !== pid && known.session === name) {
          throw new Error(
            `the sessions with backend ids ${known.pid} and ${pid} are both called "${name}", so they would share one ` +
              'gate: give each session its own label in connect(label)'
          );
        }
      }
      const id = `${pid}:${point}`;
      const known = gates.get(id);
      if (known) return known;
      const gate = makeGate(point, name, pid);
      gates.set(id, gate);
      return gate;
    },
    track: <T>(call: Promise<T>): Promise<T> => {
      tracked.add(call);
      const forget = () => {
        tracked.delete(call);
      };
      // Handling the rejection here keeps a test that fails early from leaving an unhandled one; the test still awaits `call`.
      call.then(forget, forget);
      return call;
    },
    waiters,
    waitForWaiters: async (observer, point, count, opts = {}) => {
      const timeoutMs = opts.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = await waiters(observer, point);
        if (found.length >= count) return found;
        if (Date.now() >= deadline) {
          throw new Error(
            `${found.length} of ${count} sessions reached the point "${point}" within ${timeoutMs} ms`
          );
        }
        await sleep(25);
      }
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      let stuck: Error | undefined;
      try {
        for (const gate of gates.values()) await gate.release();
        if (!(await settledWithin([...tracked], DISPOSE_WAIT_MS))) {
          stuck = new Error(
            `${tracked.size} call(s) started through the hook were still running ${DISPOSE_WAIT_MS} ms after the ` +
              'gates were opened (waiting for a lock the test still holds?). The original hook is back.'
          );
        }
      } finally {
        if (original) await controller.query(original);
        else await controller.query(`drop function if exists ${fn}(text)`);
      }
      if (stuck) throw stuck;
    },
  };
}

/**
 * installHook for the length of `work`; the hook is disposed of whatever happens, the gates are opened, the calls the
 * work tracked are waited for, and the original hook function is back. When the work and the dispose both fail, the
 * error of the work is the one thrown.
 */
export async function withHook<T>(
  controller: Client,
  work: (hook: Hook) => Promise<T>,
  options: HookOptions = {}
): Promise<T> {
  const hook = await installHook(controller, options);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await work(hook) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await hook.dispose();
  } catch (error) {
    if (outcome.ok) throw error;
  }
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}
