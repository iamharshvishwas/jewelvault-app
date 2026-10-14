import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, type ClientConfig } from 'pg';

// Connections for the database tests: one named session per Client, so a test can hold two at once (locks, concurrency).
// Every connection is made to the lane's own stack (LANE=a npm run db:test:2 sets DATABASE_URL for it).

const root = path.resolve(__dirname, '../..');

/** The password of a connection string is never printed. */
export function redact(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1***@');
}

function fromEnvLocal(name: string): string | undefined {
  try {
    const text = readFileSync(path.join(root, '.env.local'), 'utf8');
    const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/** DATABASE_URL from the environment, else from the .env.local that `npm run db:start` wrote. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? fromEnvLocal('DATABASE_URL');
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Run the database tests through the lane: LANE=a npm run db:test:2 (it starts the stack if needed).'
    );
  }
  return url;
}

export interface ConnectOptions {
  /** Another database than the lane's (a scratch database made by the test). */
  connectionString?: string;
  /** Ends any statement of this session after this long, so a hung test cannot freeze the run. Default 60 s. */
  statementTimeoutMs?: number;
  /** Optional lock timeout for the session. */
  lockTimeoutMs?: number;
}

/** A connected session named `jv-test:<label>` in pg_stat_activity. */
export async function connect(label = 'main', options: ConnectOptions = {}): Promise<Client> {
  const connectionString = options.connectionString ?? databaseUrl();
  const config: ClientConfig = { connectionString, application_name: `jv-test:${label}` };
  const client = new Client(config);
  // A session that the server ends (tests.reset_business_data ends leaked ones) must not crash the whole run.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot connect to ${redact(connectionString)} (${(error as Error).message}). ` +
        "Start this lane's stack first: LANE=<lane> npm run db:start"
    );
  }
  await client.query(`set statement_timeout = ${Math.trunc(options.statementTimeoutMs ?? 60_000)}`);
  if (options.lockTimeoutMs)
    await client.query(`set lock_timeout = ${Math.trunc(options.lockTimeoutMs)}`);
  return client;
}

/** Two sessions a and b on the same database, for a test of locks or of two requests at once. */
export async function twoConnections(): Promise<{
  a: Client;
  b: Client;
  close: () => Promise<void>;
}> {
  const a = await connect('a');
  const b = await connect('b');
  return {
    a,
    b,
    close: async () => {
      await Promise.allSettled([a.end(), b.end()]);
    },
  };
}

/**
 * The server process id of a session. Read from the connection itself, so it can be asked while the session is busy
 * with a query (a second query on the same Client would queue behind the first).
 */
export async function backendPid(client: Client): Promise<number> {
  const known = (client as unknown as { processID?: number | null }).processID;
  if (known) return known;
  const { rows } = await client.query('select pg_backend_pid() as pid');
  return rows[0].pid;
}

/** The backends that `pid` is waiting for, polled until there is at least one. Throws when it never waits. */
export async function waitUntilBlocked(
  observer: Client,
  pid: number,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<number[]> {
  const { timeoutMs = 10_000, intervalMs = 25 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await observer.query('select pg_blocking_pids($1) as blockers', [pid]);
    if (rows[0].blockers.length > 0) return rows[0].blockers;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const { rows } = await observer.query(
    'select state, wait_event_type, wait_event from pg_stat_activity where pid = $1',
    [pid]
  );
  throw new Error(
    `backend ${pid} was not blocked within ${timeoutMs} ms (${JSON.stringify(rows[0] ?? 'no such backend')})`
  );
}

/** What a backend waits for right now, from pg_stat_activity: Lock/advisory, Lock/transactionid, Lock/tuple ... */
export async function waitEvent(
  observer: Client,
  pid: number
): Promise<{ type: string | null; event: string | null }> {
  const { rows } = await observer.query(
    'select wait_event_type as type, wait_event as event from pg_stat_activity where pid = $1',
    [pid]
  );
  return rows[0] ?? { type: null, event: null };
}

export type DbRole = 'authenticated' | 'anon' | 'service_role';

export interface RoleContext {
  role: DbRole;
  /** The user in the JWT claims (auth.uid()). */
  userId?: string;
  /** More claims, or claims that replace the default ones. */
  claims?: Record<string, unknown>;
}

export interface OpenTransaction {
  query: Client['query'];
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

const ROLES: readonly DbRole[] = ['authenticated', 'anon', 'service_role'];

/**
 * Begins a transaction on the client as a request would arrive: `set local role` and the JWT claims PostgREST sets in
 * request.jwt.claims. The transaction stays open until commit or rollback, so another connection can be tested against it.
 */
export async function beginAs(client: Client, context: RoleContext): Promise<OpenTransaction> {
  if (!ROLES.includes(context.role)) throw new Error(`unknown database role ${context.role}`);
  await client.query('begin');
  try {
    await client.query(`set local role ${context.role}`);
    const claims = {
      role: context.role,
      ...(context.role === 'authenticated' ? { aud: 'authenticated' } : {}),
      ...(context.userId ? { sub: context.userId } : {}),
      ...context.claims,
    };
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
  return {
    query: client.query.bind(client) as Client['query'],
    commit: async () => {
      await client.query('commit');
    },
    rollback: async () => {
      await client.query('rollback');
    },
  };
}

/** Runs `work` inside such a transaction and rolls it back (or commits it with `{ commit: true }`). */
export async function withRole<T>(
  client: Client,
  context: RoleContext,
  work: (client: Client) => Promise<T>,
  options: { commit?: boolean } = {}
): Promise<T> {
  const tx = await beginAs(client, context);
  let value: T;
  try {
    value = await work(client);
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  }
  if (options.commit) await tx.commit();
  else await tx.rollback();
  return value;
}
