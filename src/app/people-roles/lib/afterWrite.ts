// What comes after a write of People & Roles, whichever tab or screen made it (plan: access and roles, Tasks 23 and 24; final review of the website, Ruling AB): the sentence of a write that
// failed, whether the lists must be read again, and reading them again. Plain TypeScript with no React; `personWrite.ts`, `roleWrite.ts` and `roleEdit.ts` all use it, so that every write says
// and does the same.
//   - the API's own sentence is shown as the client made it. A failure that is not the client's (a bug, a lost connection) is "Could not confirm that this was saved.";
//   - the lists are read again after EVERY failure but the two about her own password (`isPasswordRefusal`: a wrong one, and the pause after five wrong ones), and after every success. A refusal is
//     as often as not the proof that the list on screen is old (a role that another browser switched off is still offered, and refused again at every try; a name that another browser took),
//     and a failure nobody can vouch for may have gone through (a person made by an answer that was lost is not in the list, and their e-mail is "already used"): the lists say what is so
//     now, and the forms are mended from them. Her password says nothing about the lists, so those two read nothing. (The Edit role screen leaves out a stale answer too, `roleEdit.ts`:
//     its Reload button answers that, since the edits on screen are hers until she presses it;)
//   - reading the lists again is never a failure of the write: the store's own `reload` never rejects, and should one reject all the same, what the write gave (the temporary password of a
//     person who was just made) must not be lost behind it;
//   - `readRoleAgain` is for the Reload of the Edit role screen (Task 24b): it reads the one role itself and says when it could not.
import { isApiError, type ApiClient } from '@/lib/api/client';
import { UNCONFIRMED_MESSAGE } from '@/lib/api/errorMap';
import type { SuperRole } from '@/lib/api/types';

export interface Failure {
  /** The sentence to show: the API's own, or "Could not confirm that this was saved.". */
  error: string;
  /** Whether the lists must be read again: after every failure but a wrong password and the pause (see the header). */
  reread: boolean;
  /** The API refused the write before it wrote anything (the refusal says "Nothing was changed."). False for anything nobody can vouch for. */
  nothingChanged: boolean;
  /** The sentence is "Could not confirm that this was saved.": nobody can say whether the write went through. */
  unconfirmed: boolean;
}

/** A refusal of the Super Admin's own password: the wrong one (a 422 on that field, never a 401, which would end the session), or the pause after five wrong ones (a 429). */
export function isPasswordRefusal(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    ((cause.code === 'JV_INVALID_INPUT' && cause.details.field === 'password') ||
      cause.code === 'JV_RATE_LIMITED')
  );
}

/** What a write that threw says, and whether the lists are read again (see the header). */
export function failureOf(cause: unknown): Failure {
  if (!isApiError(cause))
    return { error: UNCONFIRMED_MESSAGE, reread: true, nothingChanged: false, unconfirmed: true };
  const sentence = cause.message.trim();
  const error = sentence === '' ? UNCONFIRMED_MESSAGE : sentence;
  return {
    error,
    reread: !isPasswordRefusal(cause),
    nothingChanged: cause.nothingChanged,
    unconfirmed: error === UNCONFIRMED_MESSAGE,
  };
}

/** Reads the lists again. Never throws. */
export async function readAgain(reload: () => Promise<void>): Promise<void> {
  try {
    await reload();
  } catch {
    // the store's own `reload` never rejects (a failed read shows on the screen as it is); should one reject all the same, the write is what counts
  }
}

/**
 * The role with this key as the API lists it now, or null when it could not be read: a read that failed, an answer that is not in the agreed shape, no role with that key, a role without
 * its stamp. The Reload of the Edit role screen starts again from what this gives, so the start does not wait for the lists behind the screen to be drawn again; and a null is a read that
 * failed, which `readAgain` cannot say (the store's `reload` never rejects: a failure is in its state). Never throws.
 */
export async function readRoleAgain(
  reads: Pick<ApiClient, 'superRoles'>,
  key: string
): Promise<SuperRole | null> {
  try {
    const roles = ((await reads.superRoles()) as { roles?: unknown } | null | undefined)?.roles;
    const found = Array.isArray(roles)
      ? (roles as Array<SuperRole | null>).find((one) => one?.key === key)
      : undefined;
    return found && typeof found.updated_at === 'string' ? found : null;
  } catch {
    return null;
  }
}
