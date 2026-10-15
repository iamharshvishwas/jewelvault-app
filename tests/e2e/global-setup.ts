import { randomBytes } from 'node:crypto';
import { createLogin, deleteLogin, type AppRole, type Login } from '../db/rpc';

// The logins the browser tests sign in with. They are made through the local Auth admin API (tests/db/rpc.ts: a random
// password that lives only in memory, never in a file, the output or committed SQL) and activated with
// private.activate_user, the runbook snippet (U3). One login for each role, and one that stays inactive.
//
// The e-mail addresses and passwords reach the tests through process.env of this run only: Playwright starts its workers
// after the global setup, so they see what is set here. The teardown deletes the logins again, profile first (a login
// that has a profile cannot be deleted, S7).
//
// Run through the lane, which sets the API URL, the keys and the database URL for exactly one stack:
//   LANE=b npm run test:e2e

export const ROLES: AppRole[] = ['owner', 'biller', 'staff'];

export interface E2eLogin {
  email: string;
  password: string;
  /** The name on the profile (private.activate_user is given "Test <role>"). */
  fullName: string;
}

function envName(kind: string, field: 'EMAIL' | 'PASSWORD'): string {
  return `JV_E2E_${kind.toUpperCase()}_${field}`;
}

/** The login of a role (or `inactive`) that the global setup made. Fails with a plain message when it did not run. */
export function e2eLogin(kind: AppRole | 'inactive'): E2eLogin {
  const email = process.env[envName(kind, 'EMAIL')];
  const password = process.env[envName(kind, 'PASSWORD')];
  if (!email || !password) {
    throw new Error(
      `No test login for ${kind}: the global setup did not run. Run the tests through the lane: LANE=b npm run test:e2e`
    );
  }
  return { email, password, fullName: kind === 'inactive' ? '' : `Test ${kind}` };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const run = randomBytes(4).toString('hex');
  const made: Login[] = [];
  const remember = (kind: string, login: Login) => {
    made.push(login);
    process.env[envName(kind, 'EMAIL')] = login.email;
    process.env[envName(kind, 'PASSWORD')] = login.password;
  };

  try {
    for (const role of ROLES) {
      remember(
        role,
        await createLogin({ email: `e2e-${role}-${run}@jv-test.local`, appRole: role })
      );
    }
    // A login nobody has activated: the new-user trigger gave it an inactive staff profile (D1).
    remember('inactive', await createLogin({ email: `e2e-inactive-${run}@jv-test.local` }));
  } catch (error) {
    await Promise.allSettled(made.map((login) => deleteLogin(login.id)));
    throw error;
  }

  return async () => {
    for (const login of made) await deleteLogin(login.id).catch(() => undefined);
  };
}
