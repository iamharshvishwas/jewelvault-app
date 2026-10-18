import { e2eLane } from './global-setup';

// The one-command way out of the login throttle (spec U3): the admin door's call that resets the login counters (A13). A lane's API counts
// every login of the three test users in one 15-minute window, so after five logins of the same person each further login waits 1, 2, 4 and
// then 8 seconds (A13 (1)); a spec that signs in many times asks for a clean slate before each test, so that the throttle under test is the
// test's own and not the one the earlier tests left behind. It does not touch the in-memory limits (300 calls a minute for each person).
//
// The admin door allows 10 calls a minute from one address, and some specs use it for their own work, so this is best effort: it does not
// ask more than once in 8 seconds, and a 429 is not waited out (a slow login is the worst that can follow, and the test still passes).
let lastAsked = 0;
export async function clearLoginCounters(): Promise<void> {
  if (Date.now() - lastAsked < 8_000) return;
  lastAsked = Date.now();
  const { apiUrl, adminToken } = e2eLane();
  const response = await fetch(`${apiUrl}/admin/v1/login-counters/clear`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (response.status !== 200 && response.status !== 429) {
    throw new Error(`the admin door refused to clear the login counters: ${response.status}`);
  }
}
