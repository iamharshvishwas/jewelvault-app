// The two writes of the Roles tab that go through the password step (plan: access and roles, Task 24; API Task 13): a new role (a copy of another) and a role switched off or on. Each is one
// call of the client with the Super Admin's own password in its body (R9), and after it the lists are read again. Plain TypeScript with no React: the client and the reload are passed in, so
// the unit tests give it stubs. (Renaming a role and setting its ticks are the Edit role screen, Task 25.)
//   - the password goes to the one call and nowhere else: not into the address (the key is the only part of it), not into what this returns, not into any message;
//   - the switch names the `updated_at` the role was listed with (R9): a role changed in another tab since is refused as stale. Nothing was written, but the row on screen is old, so the lists
//     are read again and the outcome says `stale`: the password step ends there (Task 24b) and the tab says why. A retry on the same step would name the old stamp and be refused for ever;
//     starting the change again from the fresh row would be wrong, since the switch goes the OTHER way from the way the row is (another browser may have switched the role already);
//   - the lists are read again after every success and after every failure but the two about her own password (a wrong one, the pause; `afterWrite.ts`, final review of the website, Ruling AB):
//     a rule's refusal (a role that people have cannot be switched off: the people count of the row may be old, since giving a person the role in another tab does not change the role's own
//     stamp), a name that another browser has just taken (the form compares with the lists it holds), and an outcome nobody can vouch for (a role made by an answer that was lost is in the list);
//   - the API's own sentence is shown as the client made it (`failureOf` of afterWrite.ts: "The Owner role is fixed ..." is the API's own), with one exception, `roleRefusalWords`: the
//     one clash of names the form cannot catch is said in the form's own plain words (Task 24b).
import { isApiError, type ApiClient } from '@/lib/api/client';
import { apiPartOf, failureOf, readAgain } from './afterWrite';
import type { RoleChange } from './roleChange';
import { NAME_TAKEN } from './roles';

/** The part of the client the two writes use. */
export type RoleWrites = Pick<ApiClient, 'superCreateRole' | 'superSetRoleActive'>;

export interface RoleOutcome {
  /** The sentence to show when the write was refused or could not be confirmed, else null. */
  error: string | null;
  /**
   * Present, and true, only when the role was changed by someone else since the row on screen was listed (`JV_STALE`): nothing was written and the lists were read again. The password
   * step is over then, and `error` (the client's sentence for it) is not shown.
   */
  stale?: true;
}

/** How the API's sentence for a name that another role has ends (API Task 13, src/super/roles.ts: `name is already used by another role`). */
const NAME_CLASH_ENDING = 'is already used by another role';

/**
 * The words for the refusal of a role write (a new role, a rename), given the sentence that `failureOf` made of it: that sentence, except for the one clash of names the form cannot catch.
 * The form compares names by capitals and spaces; the API also ignores accents and zero-width characters, so a name that only differs in one of those passes the form and is refused 422
 * on `name` ("name is already used by another role"), in the API's field word and, from the client, with "Nothing was changed." after it. That is said as the form says it ("Another role
 * already has this name."). Every other refusal keeps its words, every other 422 on `name` too (no letter or number, empty, too long: the form catches them first).
 */
export function roleRefusalWords(cause: unknown, sentence: string): string {
  if (!isApiError(cause) || cause.code !== 'JV_INVALID_INPUT' || cause.details.field !== 'name')
    return sentence;
  return apiPartOf(sentence).endsWith(NAME_CLASH_ENDING) ? NAME_TAKEN : sentence;
}

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

/** Does the write, then reads the lists again, unless her password was refused (see the header). Never throws: a failure is the `error` of the outcome. */
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
    const failure = failureOf(cause);
    outcome = {
      error: roleRefusalWords(cause, failure.error),
      ...(isApiError(cause) && cause.code === 'JV_STALE' ? { stale: true as const } : {}),
    };
    reread = failure.reread;
  }
  if (reread) await readAgain(reload);
  return outcome;
}
