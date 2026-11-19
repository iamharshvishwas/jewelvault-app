// The write of the Edit role screen (plan: access and roles, Task 25; API Task 13): what a save is (`RoleEdit`), and the one or two calls of the client that do it, with the Super Admin's own
// password in their bodies (R9) and the lists read again after. Plain TypeScript with no React: the client and the reload are passed in, so the unit tests give it stubs.
//   - a save is up to two writes, in this order: the name and the description (`superEditRole`, only the fields that changed), then the ticks (`superSetRoleTicks`, the whole set in
//     catalogue order). Each names the `updated_at` of the role as the caller has it. The first answers with the role as it is now, so the second names THAT stamp: a role changed by
//     someone else in between is still refused as stale, and our own first write never makes the second one stale;
//   - the password goes to the bodies and nowhere else: not into an address (the key is the only part of one), not into what this returns, not into any message;
//   - the outcome says what the screen has to do: `saved` (the role as the API now lists it), `password` (the password was refused, or the Super Admin is paused after wrong ones: nothing
//     was written and the password step stays, with the sentence), `stale` (the role was changed by someone else), `refused` (any other refusal, or an outcome nobody can vouch for: the
//     API's own sentence). `saved` on `stale` and `refused` is the role after the FIRST write when that one went through and the second did not, else null; the screen takes it as the
//     role it is editing from now on;
//   - the lists are read again after every success, after anything that was written (the first write alone), and after an outcome nobody can vouch for. A refusal that wrote nothing reads
//     nothing again, and a stale one does not either: the "Reload" button of the screen does that when she asks for it, since the edits on screen are hers until then;
//   - when the first write went through the second can no longer be answered on the password step (the step would write the first part again): whatever refused the second is shown on
//     the screen, with what was saved.
import type { TickKey } from '@/lib/access';
import { isApiError, type ApiClient } from '@/lib/api/client';
import { NOTHING_CHANGED } from '@/lib/api/errorMap';
import type { SuperRole, SuperRoleAnswer } from '@/lib/api/types';
import { failureOf, readAgain } from './afterWrite';

/** The part of the client the save uses. */
export type RoleEditWrites = Pick<ApiClient, 'superEditRole' | 'superSetRoleTicks'>;

/** What a save writes: only what changed. */
export interface RoleEdit {
  /** The role as it was when the edit was made: its key, its name for the words, and the `updated_at` the first write names. */
  role: SuperRole;
  /** The new name, as the API keeps it, when it changed. */
  name?: string;
  /** The new description (trimmed; an empty text empties it), when it changed. */
  description?: string;
  /** The whole new set of ticks, in catalogue order, when it changed. */
  ticks?: TickKey[];
}

export type RoleEditOutcome =
  | { kind: 'saved'; role: SuperRole }
  | { kind: 'password'; error: string }
  | { kind: 'stale'; saved: SuperRole | null }
  | { kind: 'refused'; error: string; saved: SuperRole | null };

/**
 * What was saved and what was not, when the first write went through and the second did not, then the reason. `wroteNothing`: the refusal says nothing was written; else nobody can say.
 * The client ends the sentence of a refusal with "Nothing was changed." (right for one write); here something WAS changed, so that closing phrase, and only it, is left off.
 */
export function partlySaved(edit: RoleEdit, sentence: string, wroteNothing = true): string {
  const what =
    edit.name !== undefined && edit.description !== undefined
      ? 'The name and description were'
      : edit.name !== undefined
        ? 'The name was'
        : 'The description was';
  if (!wroteNothing) return `${what} saved. Could not confirm that the ticks were saved.`;
  const reason = sentence.endsWith(NOTHING_CHANGED)
    ? sentence.slice(0, -NOTHING_CHANGED.length).trimEnd()
    : sentence;
  return `${what} saved, but the ticks were not.${reason === '' ? '' : ` ${reason}`}`;
}

/** The role of an answer. An answer without one (the agreed shape drifted) throws: an outcome nobody can vouch for. */
function roleOf(answer: SuperRoleAnswer): SuperRole {
  const role = (answer as { role?: SuperRole } | null)?.role;
  if (role === undefined || typeof role.updated_at !== 'string')
    throw new Error('No role in the answer.');
  return role;
}

/** A refusal of the Super Admin's own password: the wrong one (a 422 on that field, never a 401), or the pause after five wrong ones. */
function isPasswordRefusal(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    ((cause.code === 'JV_INVALID_INPUT' && cause.details.field === 'password') ||
      cause.code === 'JV_RATE_LIMITED')
  );
}

/** Does the save, then reads the lists again unless nothing was written. Never throws: a failure is the kind of the outcome. */
export async function runRoleEdit(
  writes: RoleEditWrites,
  reload: () => Promise<void>,
  edit: RoleEdit,
  password: string
): Promise<RoleEditOutcome> {
  let saved: SuperRole | null = null;
  try {
    let stamp = edit.role.updated_at;
    let last: SuperRole | null = null;
    const changes = {
      ...(edit.name === undefined ? {} : { name: edit.name }),
      ...(edit.description === undefined ? {} : { description: edit.description }),
    };
    if (Object.keys(changes).length > 0) {
      const answer = roleOf(
        await writes.superEditRole(edit.role.key, {
          expected_updated_at: stamp,
          changes,
          password,
        })
      );
      saved = last = answer;
      stamp = answer.updated_at;
    }
    if (edit.ticks !== undefined) {
      last = roleOf(
        await writes.superSetRoleTicks(edit.role.key, {
          expected_updated_at: stamp,
          ticks: edit.ticks,
          password,
        })
      );
    }
    // an edit with nothing in it is nothing to write
    if (last === null) return { kind: 'saved', role: edit.role };
    await readAgain(reload);
    return { kind: 'saved', role: last };
  } catch (cause) {
    const failure = failureOf(cause);
    // something was written, or nobody can say that nothing was: the lists are read again
    if (saved !== null || failure.reread) await readAgain(reload);
    if (isApiError(cause) && cause.code === 'JV_STALE') return { kind: 'stale', saved };
    if (saved === null && isPasswordRefusal(cause))
      return { kind: 'password', error: failure.error };
    return {
      kind: 'refused',
      error: saved === null ? failure.error : partlySaved(edit, failure.error, !failure.reread),
      saved,
    };
  }
}
