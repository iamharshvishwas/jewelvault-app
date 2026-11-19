// The five writes of the People tab (plan: access and roles, Task 23; API Task 14): each is one call of the client with the Super Admin's own password in its body (R9), and after it the
// lists are read again. Plain TypeScript with no React: the client and the reload are passed in, so the unit tests give it stubs.
//   - the password goes to the one call and nowhere else: not into the address (the id is the only part of it), not into what this returns, not into any message;
//   - the lists are read again after every success and after every failure but the two about her own password (a wrong one, the pause): a refusal is often the proof that the list on screen
//     is old (a role that another browser switched off is still offered by the forms; a person made by an answer that was lost is not in the list, and their e-mail is "already used"), and
//     a write whose outcome nobody can vouch for may have gone through. The step answers after the lists have been read (`afterWrite.ts`, final review of the website, Ruling AB);
//   - the API's own sentence is shown as the client made it, except two that read like a log line and are said in plain words (`personRefusalWords`: a taken e-mail, a role that is switched off).
//     A failure that is not the client's (a bug, a lost connection) is "Could not confirm that this was saved." (`failureOf` of afterWrite.ts, which the Roles tab uses too);
//   - adding a person and resetting a password answer with a temporary password, shown once by the dialog. An answer without it is the one thing that is spelled out here: the person
//     was made (or the password was reset), nothing can be shown, and the way on is another reset;
//   - an Add person or a Reset whose outcome nobody can vouch for (a lost answer) says "Could not confirm that this was saved." and then, in one more sentence, the way on (`IF_LISTED_LINE`,
//     final review of the website, M2): the answer carried the one-time password, so the person may exist now with the password gone. The lists are read again, so the person is in the list
//     if they were made. The other three writes have no password to lose and say only the first sentence.
import { isApiError, type ApiClient } from '@/lib/api/client';
import type { SuperNewPersonAnswer, SuperResetAnswer } from '@/lib/api/types';
import { apiPartOf, failureOf, readAgain } from './afterWrite';
import { EMAIL_TAKEN, ROLE_SWITCHED_OFF } from './people';
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

/** Said after "Could not confirm that this was saved." for an Add person or a Reset: the temporary password was in the answer that was lost (final review of the website, M2). */
export const IF_LISTED_LINE =
  'If the person is now in the list, use Reset password to get a new temporary password.';

/** How the API's sentence for a taken e-mail ends (API Task 14, src/admin/routes.ts: `email is already used by another user`; an edit refuses it the same way). */
const EMAIL_CLASH_ENDING = 'is already used by another user';
/** How the API's sentence for a role that is switched off, or that is not there, ends (src/permissions/roleStore.ts: `role is not an active role`). */
const ROLE_OFF_ENDING = 'is not an active role';

/**
 * The words for the refusal of a people write, given the sentence that `failureOf` made of it: that sentence, except for the two sentences of the API that begin with its own lower-case field
 * word and read like a log line (final review of the website, Ruling AB (c); Task 26 part 2 met both in the real browser): a 422 on `email` whose sentence ends with `is already used by
 * another user` reads "Another person already has this e-mail.", and a 422 on `role` whose sentence ends with `is not an active role` reads "That role is switched off. Choose another
 * role.". The form cannot catch either (the e-mail is compared by the database, the role may have been switched off in another browser since the form was opened). Only these, only on
 * their own field: every other refusal keeps the API's words, and so does the same sentence on another field or under another code. The END of the sentence counts (as in `roleRefusalWords`),
 * so a sentence that merely contains the words is left alone.
 */
export function personRefusalWords(cause: unknown, sentence: string): string {
  if (!isApiError(cause) || cause.code !== 'JV_INVALID_INPUT') return sentence;
  const said = apiPartOf(sentence);
  if (cause.details.field === 'email' && said.endsWith(EMAIL_CLASH_ENDING)) return EMAIL_TAKEN;
  if (cause.details.field === 'role' && said.endsWith(ROLE_OFF_ENDING)) return ROLE_SWITCHED_OFF;
  return sentence;
}

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

/**
 * Does the write, then reads the lists again, unless her password was refused (see the header). Never throws: a failure is the `error` of the outcome, and a read of the lists that fails is not a failure of the
 * write (the temporary password of a person who was just made must reach the screen whatever the lists do).
 */
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
    const failure = failureOf(cause);
    const said = personRefusalWords(cause, failure.error);
    // an Add person or a Reset whose answer was lost: the person may be there now, and the one-time password is gone: say what to do
    const lostPassword = failure.unconfirmed && (change.kind === 'add' || change.kind === 'reset');
    outcome = { error: lostPassword ? `${said} ${IF_LISTED_LINE}` : said, temporary: null };
    reread = failure.reread;
  }
  if (reread) await readAgain(reload);
  return outcome;
}
