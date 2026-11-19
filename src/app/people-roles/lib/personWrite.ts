// The five writes of the People tab (plan: access and roles, Task 23; API Task 14): each is one call of the client with the Super Admin's own password in its body (R9), and after it the
// lists are read again. Plain TypeScript with no React: the client and the reload are passed in, so the unit tests give it stubs.
//   - the password goes to the one call and nowhere else: not into the address (the id is the only part of it), not into what this returns, not into any message;
//   - a write that was refused with a sentence that says nothing was changed (a wrong password, the pause, a taken e-mail, a stale change) reads nothing again: nothing happened. Any other
//     failure, and every success, reads the lists again: a write whose outcome nobody can vouch for may have gone through;
//   - the API's own sentence is shown as the client made it. A failure that is not the client's (a bug, a lost connection) is "Could not confirm that this was saved.";
//   - adding a person and resetting a password answer with a temporary password, shown once by the dialog. An answer without it is the one thing that is spelled out here: the person
//     was made (or the password was reset), nothing can be shown, and the way on is another reset.
import { isApiError, type ApiClient } from '@/lib/api/client';
import { UNCONFIRMED_MESSAGE } from '@/lib/api/errorMap';
import type { SuperNewPersonAnswer, SuperResetAnswer } from '@/lib/api/types';
import type { PersonChange } from './personChange';

/** The part of the client the five writes use. */
export type PeopleWrites = Pick<
  ApiClient,
  | 'superAddPerson'
  | 'superEditPerson'
  | 'superSetPersonRole'
  | 'superSetPersonActive'
  | 'superResetPassword'
>;

/** A temporary password and whom it is for: shown once, and in no other place than the state of the dialog that shows it. */
export interface TemporaryPassword {
  kind: 'add' | 'reset';
  name: string;
  email: string;
  password: string;
  /** How many sessions a reset ended, when the answer said (never for a new person). */
  sessionsEnded: number | null;
}

export interface ChangeOutcome {
  /** The sentence to show when the write was refused or could not be confirmed, else null. */
  error: string | null;
  /** The temporary password to show once (adding, resetting), else null. */
  temporary: TemporaryPassword | null;
}

const DONE: ChangeOutcome = { error: null, temporary: null };

const NO_TEMPORARY_PASSWORD = {
  add: 'The person was added, but the temporary password could not be read. Use "Reset password" to get a new one.',
  reset:
    'The password was reset, but the new temporary password could not be read. Use "Reset password" again to get a new one.',
} as const;

function temporaryOutcome(
  kind: 'add' | 'reset',
  answer: SuperNewPersonAnswer | SuperResetAnswer,
  name: string,
  email: string
): ChangeOutcome {
  const given = answer?.temporary_password;
  if (typeof given !== 'string' || given === '')
    return { error: NO_TEMPORARY_PASSWORD[kind], temporary: null };
  const sessions = (answer as Partial<SuperResetAnswer>).sessions_ended;
  return {
    error: null,
    temporary: {
      kind,
      name: answer.person?.full_name ?? name,
      email: answer.person?.email ?? email,
      password: given,
      sessionsEnded: kind === 'reset' && typeof sessions === 'number' ? sessions : null,
    },
  };
}

async function send(
  writes: PeopleWrites,
  change: PersonChange,
  password: string
): Promise<ChangeOutcome> {
  switch (change.kind) {
    case 'add':
      return temporaryOutcome(
        'add',
        await writes.superAddPerson({
          full_name: change.full_name,
          email: change.email,
          role: change.role,
          password,
        }),
        change.full_name,
        change.email
      );
    case 'edit':
      await writes.superEditPerson(change.person.id, { changes: change.changes, password });
      return DONE;
    case 'role':
      await writes.superSetPersonRole(change.person.id, { role: change.role, password });
      return DONE;
    case 'switch':
      await writes.superSetPersonActive(change.person.id, { active: change.active, password });
      return DONE;
    case 'reset':
      return temporaryOutcome(
        'reset',
        await writes.superResetPassword(change.person.id, { password }),
        change.person.full_name,
        change.person.email
      );
  }
}

/** Does the write, then reads the lists again unless nothing was written. Never throws: a failure is the `error` of the outcome. */
export async function runChange(
  writes: PeopleWrites,
  reload: () => Promise<void>,
  change: PersonChange,
  password: string
): Promise<ChangeOutcome> {
  let outcome: ChangeOutcome;
  let reread = true;
  try {
    outcome = await send(writes, change, password);
  } catch (cause) {
    const sentence = isApiError(cause) ? cause.message.trim() : '';
    outcome = { error: sentence === '' ? UNCONFIRMED_MESSAGE : sentence, temporary: null };
    reread = !(isApiError(cause) && cause.nothingChanged);
  }
  if (reread) await reload();
  return outcome;
}
