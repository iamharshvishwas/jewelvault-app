import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { connect } from './pg';

// A real login and calls over HTTP, the way the browser makes them: through the API gateway, the JWT check, PostgREST
// and the role settings of the platform. A pgTAP test that impersonates a user with `set local role` skips all of that,
// so it cannot see the role's statement timeout (8 seconds on the platform, 15 seconds after migration 0001).
//
// Logins are created through the Auth admin API with a random password that lives only in memory. Nothing here writes a
// key or a password to a file or to the output.

const root = path.resolve(__dirname, '../..');

export interface ApiEnv {
  apiUrl: string;
  publishableKey: string;
  /** The local secret key, used only for the Auth admin API. It comes from the environment `npm run db:test:2` sets. */
  secretKey: string;
}

function fromEnvLocal(name: string): string | undefined {
  try {
    const match = new RegExp(`^${name}=(.*)$`, 'm').exec(
      readFileSync(path.join(root, '.env.local'), 'utf8')
    );
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function secretFromCli(): string {
  const lane = process.env.JV_LANE ?? process.env.LANE;
  if (!lane)
    throw new Error(
      'JV_SECRET_KEY is not set and there is no LANE to ask the Supabase CLI. Run LANE=a npm run db:test:2'
    );
  const bin = path.join(root, 'node_modules', '.bin', 'supabase');
  const text = execFileSync(
    bin,
    ['status', '-o', 'json', '--workdir', path.join(root, '.lanes', lane)],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  );
  return JSON.parse(text.slice(text.indexOf('{'))).SECRET_KEY as string;
}

let cached: ApiEnv | undefined;

export function apiEnv(): ApiEnv {
  if (!cached) {
    const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fromEnvLocal('NEXT_PUBLIC_SUPABASE_URL');
    const publishableKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      fromEnvLocal('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    if (!apiUrl || !publishableKey) {
      throw new Error(
        'The API URL and key are not set. Run the tests through the lane: LANE=a npm run db:test:2'
      );
    }
    cached = { apiUrl, publishableKey, secretKey: process.env.JV_SECRET_KEY ?? secretFromCli() };
  }
  return cached;
}

export interface ApiResult<T = unknown> {
  status: number;
  /** Milliseconds from sending the request to the whole answer: how a timeout shows. */
  ms: number;
  body: T;
}

async function timed<T = unknown>(url: string, init: RequestInit): Promise<ApiResult<T>> {
  const started = Date.now();
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, ms: Date.now() - started, body: body as T };
}

const adminHeaders = (env: ApiEnv) => ({
  apikey: env.secretKey,
  authorization: `Bearer ${env.secretKey}`,
  'content-type': 'application/json',
});

export type AppRole = 'owner' | 'biller' | 'staff';

export interface Login {
  id: string;
  email: string;
  /** Random, in memory only. */
  password: string;
  accessToken: string;
  refreshToken: string;
}

/** Signs in with email and password and returns the tokens. */
export async function signIn(
  email: string,
  password: string
): Promise<{ accessToken: string; refreshToken: string; id: string }> {
  const env = apiEnv();
  const res = await timed<{
    access_token?: string;
    refresh_token?: string;
    user?: { id: string };
    msg?: string;
  }>(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`sign-in of ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    accessToken: res.body.access_token,
    refreshToken: res.body.refresh_token ?? '',
    id: res.body.user?.id ?? '',
  };
}

/**
 * Creates a confirmed user through the Auth admin API (sign-up is off in this stack) and signs in. With `appRole`, the
 * profile is made active with that role once profiles exist (task DB02); before that there is nothing to activate.
 */
export async function createLogin(
  options: { email?: string; appRole?: AppRole } = {}
): Promise<Login> {
  const env = apiEnv();
  const email = options.email ?? `login-${randomBytes(5).toString('hex')}@jv-test.local`;
  const password = `${randomBytes(18).toString('base64url')}Aa1`;
  const created = await timed<{ id?: string; msg?: string }>(`${env.apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(env),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.status !== 200 || !created.body.id) {
    throw new Error(`creating ${email} failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const tokens = await signIn(email, password);
  if (options.appRole) await activateProfile(created.body.id, email, options.appRole);
  return {
    id: created.body.id,
    email,
    password,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

async function activateProfile(id: string, email: string, role: AppRole): Promise<void> {
  const db = await connect('rpc-activate');
  try {
    const { rows } = await db.query(
      "select to_regclass('public.profiles') is not null as profiles, to_regprocedure('private.activate_user(text,text,text)') is not null as activate"
    );
    if (!rows[0].profiles) return;
    if (rows[0].activate) {
      await db.query('select private.activate_user($1, $2, $3)', [email, role, `Test ${role}`]);
    } else {
      await db.query('update public.profiles set role = $2, active = true where id = $1', [
        id,
        role,
      ]);
    }
  } finally {
    await db.end();
  }
}

/** Deletes the login again. A login that is already gone is not an error. */
export async function deleteLogin(id: string): Promise<void> {
  const env = apiEnv();
  const res = await timed(`${env.apiUrl}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: adminHeaders(env),
  });
  if (res.status !== 200 && res.status !== 404)
    throw new Error(`deleting ${id} failed: ${res.status} ${JSON.stringify(res.body)}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls a function of the public schema over HTTP as `who`: a login, a bare access token, or null for a caller with no
 * login (the role anon). A function created a moment ago may not be in the API's schema cache yet; a 404 PGRST202 is
 * retried for `schemaWaitMs`.
 */
export async function rpc<T = unknown>(
  who: Login | string | null,
  fn: string,
  args: Record<string, unknown> = {},
  options: { schemaWaitMs?: number } = {}
): Promise<ApiResult<T>> {
  const env = apiEnv();
  const token = typeof who === 'string' ? who : who?.accessToken;
  const headers: Record<string, string> = {
    apikey: env.publishableKey,
    'content-type': 'application/json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const deadline = Date.now() + (options.schemaWaitMs ?? 5000);
  for (;;) {
    const res = await timed<T>(`${env.apiUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    const code = (res.body as { code?: string } | null)?.code;
    if (res.status === 404 && code === 'PGRST202' && Date.now() < deadline) {
      await sleep(100);
      continue;
    }
    return res;
  }
}

/** Any other call to the REST API (a table read, the schema document), with the publishable key and optionally a token. */
export async function restFetch<T = unknown>(
  pathAndQuery: string,
  options: {
    token?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<ApiResult<T>> {
  const env = apiEnv();
  const headers: Record<string, string> = {
    apikey: env.publishableKey,
    'content-type': 'application/json',
    ...options.headers,
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return timed<T>(`${env.apiUrl}${pathAndQuery}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
