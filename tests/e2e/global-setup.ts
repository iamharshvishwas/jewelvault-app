import { assertLane } from '../../scripts/e2e-ports.cjs';

// The global setup of the end-to-end tests (WEB00). It starts the lane (scripts/e2e-lane.mjs): a MariaDB container, the API built from
// JV_API_DIR, and an owner, a biller and a staff user made through the admin door. Its teardown stops the API and removes the container
// (`docker rm -fv`, no volume), also when a test failed.
//
// Nothing starts unless E2E=1 says so, because it starts Docker containers and a server:
//   LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/harness.spec.ts
//
// The lane's e-mail addresses, passwords and admin token reach the tests through process.env of this run only (Playwright starts its
// workers after the global setup, so they see what is set here); the file the lane writes, .lanes/<lane>/.env.local, is local and never
// committed. In a test: `e2eLogin('owner')` gives a login, `e2eLane()` the addresses and the admin token (to make a user of its own
// through the admin door).

export const ROLES = ['owner', 'biller', 'staff'] as const;
export type E2eRole = (typeof ROLES)[number];

export interface E2eLogin {
  email: string;
  password: string;
  /** The name on the user (the admin door was given "Test <role>"). */
  fullName: string;
}

export interface E2eLane {
  /** The API's origin, for example http://localhost:4229: the only address the site calls. */
  apiUrl: string;
  /** The site's origin, the one the API allows (ALLOWED_ORIGINS). */
  webOrigin: string;
  /** The token of the lane's admin door (/admin/v1/*). It belongs to this lane's throw-away API only. */
  adminToken: string;
}

function fromEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: the global setup did not run. Run the tests with E2E=1 LANE=<lane> JV_API_DIR=<jewelvault-api checkout>.`
    );
  }
  return value;
}

/** The login of a role that the lane made through the admin door. Fails with a plain message when the lane did not start. */
export function e2eLogin(role: E2eRole): E2eLogin {
  const name = role.toUpperCase();
  return {
    email: fromEnv(`JV_E2E_${name}_EMAIL`),
    password: fromEnv(`JV_E2E_${name}_PASSWORD`),
    fullName: `Test ${role}`,
  };
}

/** The addresses and the admin token of the running lane. */
export function e2eLane(): E2eLane {
  return {
    apiUrl: fromEnv('JV_E2E_API_URL'),
    webOrigin: fromEnv('JV_E2E_WEB_ORIGIN'),
    adminToken: fromEnv('JV_E2E_ADMIN_TOKEN'),
  };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E !== '1') {
    throw new Error(
      'The end-to-end tests start a MariaDB container and an API on this computer. Say so with E2E=1, for example: ' +
        'LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test'
    );
  }
  const name = assertLane(process.env.LANE);
  // Loaded here and not at the top: Playwright compiles the files it imports to CommonJS, and the lane tool is an ES module (it uses import.meta).
  const { laneUp } = await import('../../scripts/e2e-lane.mjs');
  const lane = await laneUp(name);
  for (const [name, value] of Object.entries(lane.env)) {
    if (name.startsWith('JV_E2E_')) process.env[name] = value;
  }
  return async () => {
    await lane.stop();
  };
}
