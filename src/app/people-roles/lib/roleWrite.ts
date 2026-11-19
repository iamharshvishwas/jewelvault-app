// The two writes of the Roles tab that go through the password step (plan: access and roles, Task 24; API Task 13): a new role (a copy of another) and a role switched off or on. Each is one
// call of the client with the Super Admin's own password in its body (R9), and after it the lists are read again. Plain TypeScript with no React: the client and the reload are passed in, so
// the unit tests give it stubs. (Renaming a role and setting its ticks are the Edit role screen, Task 25.)
//   - the password goes to the one call and nowhere else: not into the address (the key is the only part of it), not into what this returns, not into any message;
//   - the switch names the `updated_at` the role was listed with (R9): a role changed in another tab since is refused as stale. Nothing was written, but the row on screen is old, so the lists
//     are read again and the dialog stays on the password step with the client's words;
//   - a rule's refusal (a role that people have cannot be switched off) reads the lists again too: the people count of the row may be old, since giving a person the role in another tab does
//     not change the role's own stamp. Every other refusal that says nothing was written reads nothing again, and every success and every outcome nobody can vouch for reads again;
//   - the API's own sentence is shown as the client made it (`failureOf` of afterWrite.ts: a name already used is the API's own, and so is "The Owner role is fixed ...").
import type { ApiClient } from '@/lib/api/client';
import { failureOf, readAgain } from './afterWrite';
import type { RoleChange } from './roleChange';

/** The part of the client the two writes use. */
export type RoleWrites = Pick<ApiClient, 'superCreateRole' | 'superSetRoleActive'>;

export interface RoleOutcome {
  /** The sentence to show when the write was refused or could not be confirmed, else null. */
  error: string | null;
}

/** Refusals that wrote nothing but prove that the list on screen is old: a role changed by someone else, and a rule (the people count of the row moved). */
const LIST_IS_OLD = ['JV_STALE', 'JV_NOT_ALLOWED'] as const;

async function send(writes: RoleWrites, change: RoleChange, password: string): Promise<void> {
  switch (change.kind) {
    case 'create':
      await writes.superCreateRole({
        copy_of: change.copy_of,
        name: change.name,
        // an empty description is no description: nothing is sent
        ...(change.description === '' ? {} : { description: change.description }),
        password,
      });
      return;
    case 'switch':
      await writes.superSetRoleActive(change.role.key, {
        expected_updated_at: change.role.updated_at,
        active: change.active,
        password,
      });
      return;
  }
}

/** Does the write, then reads the lists again unless nothing was written. Never throws: a failure is the `error` of the outcome. */
export async function runRoleChange(
  writes: RoleWrites,
  reload: () => Promise<void>,
  change: RoleChange,
  password: string
): Promise<RoleOutcome> {
  let outcome: RoleOutcome = { error: null };
  let reread = true;
  try {
    await send(writes, change, password);
  } catch (cause) {
    const failure = failureOf(cause, LIST_IS_OLD);
    outcome = { error: failure.error };
    reread = failure.reread;
  }
  if (reread) await readAgain(reload);
  return outcome;
}
