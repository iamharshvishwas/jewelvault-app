import type { Client } from 'pg';

// The test hook of spec X0 item 8, and the negative control behind T-C09 to T-C14.
//
// Every writing function calls private.test_pause('<function>.after_read') once, after it has read the customer's state
// and before it allocates; in production that function is empty. A two-session test replaces it, committed so that every
// session sees it, by one that waits on an advisory lock when it is called with the point it wants to hold. The test
// holds that lock, starts the first caller, sees it stop at the point (it is waiting for the advisory lock, and it
// holds the customer lock), starts the second caller and sees that it cannot reach the point (it waits for the
// customer lock, behind the first). A plain wait on the customer row would not prove the lock, because the foreign key
// of the bill insert takes its own lock on the same row.
//
// The same test must fail when the lock is removed. mutateFunction commits a changed copy of a function (for example
// with its `for update` cut out), returns the way back, and refuses a change that changes nothing, so a negative
// control can never pass for the wrong reason.

export const DEFAULT_PAUSE_FN = 'private.test_pause';

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

export interface GateOptions {
  /** The hook function to replace. Default private.test_pause. */
  fn?: string;
  /** The advisory lock key. Default derived from the point. */
  key?: [number, number];
}

export interface Gate {
  readonly point: string;
  readonly key: [number, number];
  /** Takes the advisory lock in the controlling session: callers of the point now wait. */
  hold(): Promise<void>;
  /** Lets the waiting callers through, one after the other. */
  release(): Promise<void>;
  /** The backend ids that wait at the point right now. */
  waiters(observer: Client): Promise<number[]>;
  /** Polls until `count` backends wait at the point; throws when they do not arrive in time. */
  waitForWaiters(
    observer: Client,
    count: number,
    options?: { timeoutMs?: number }
  ): Promise<number[]>;
  /** Puts the original hook function back. */
  dispose(): Promise<void>;
}

function keyFor(point: string): [number, number] {
  let hash = 7;
  for (const ch of point) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  return [71_000, hash];
}

/**
 * Replaces the hook function (committed) by one that waits on an advisory lock at `point`. `controller` is the session
 * that holds the lock; it must stay connected while a test needs the gate closed.
 */
export async function createGate(
  controller: Client,
  point: string,
  options: GateOptions = {}
): Promise<Gate> {
  const fn = options.fn ?? DEFAULT_PAUSE_FN;
  const key = options.key ?? keyFor(point);
  const signature = `${fn}(text)`;
  const hadOriginal = (
    await controller.query('select to_regprocedure($1) is not null as found', [signature])
  ).rows[0].found as boolean;
  const original = hadOriginal ? await getFunctionDef(controller, signature) : null;
  await controller.query(`
    create or replace function ${fn}(p_point text) returns void language plpgsql as $f$
    begin
      if p_point = ${literal(point)} then
        perform pg_advisory_lock(${key[0]}, ${key[1]});
        perform pg_advisory_unlock(${key[0]}, ${key[1]});
      end if;
    end $f$;
  `);

  const waiters = async (observer: Client): Promise<number[]> => {
    const { rows } = await observer.query(
      `select pid from pg_locks
        where locktype = 'advisory' and not granted and classid = $1 and objid = $2 and objsubid = 2
        order by pid`,
      [key[0], key[1]]
    );
    return rows.map((row) => row.pid as number);
  };

  return {
    point,
    key,
    hold: async () => {
      await controller.query('select pg_advisory_lock($1, $2)', key);
    },
    release: async () => {
      await controller.query('select pg_advisory_unlock($1, $2)', key);
    },
    waiters,
    waitForWaiters: async (observer, count, opts = {}) => {
      const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
      for (;;) {
        const found = await waiters(observer);
        if (found.length >= count) return found;
        if (Date.now() >= deadline) {
          throw new Error(
            `${found.length} of ${count} callers reached the point "${point}" within the time allowed`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    dispose: async () => {
      if (original) await controller.query(original);
      else await controller.query(`drop function if exists ${fn}(text)`);
    },
  };
}

function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}
