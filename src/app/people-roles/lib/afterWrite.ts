// What comes after a write of People & Roles, whichever tab made it (plan: access and roles, Tasks 23 and 24): the sentence of a write that failed, whether the lists must be read again, and
// reading them again. Plain TypeScript with no React; `personWrite.ts` and `roleWrite.ts` both use it, so that the two tabs say and do the same.
//   - the API's own sentence is shown as the client made it. A failure that is not the client's (a bug, a lost connection) is "Could not confirm that this was saved.";
//   - a refusal that says nothing was written reads nothing again: nothing happened. Any other failure, and every success, reads the lists again: a write whose outcome nobody can vouch
//     for may have gone through. A caller can name codes that are read again all the same (`alsoReread`): the list on screen is old, and the refusal is the proof (a role changed by someone
//     else);
//   - reading the lists again is never a failure of the write: the store's own `reload` never rejects, and should one reject all the same, what the write gave (the temporary password of a
//     person who was just made) must not be lost behind it.
import { isApiError } from '@/lib/api/client';
import { UNCONFIRMED_MESSAGE } from '@/lib/api/errorMap';

export interface Failure {
  /** The sentence to show: the API's own, or "Could not confirm that this was saved.". */
  error: string;
  /** Whether the lists must be read again. */
  reread: boolean;
}

/** What a write that threw says, and whether the lists are read again (see the header). */
export function failureOf(cause: unknown, alsoReread: readonly string[] = []): Failure {
  if (!isApiError(cause)) return { error: UNCONFIRMED_MESSAGE, reread: true };
  const sentence = cause.message.trim();
  return {
    error: sentence === '' ? UNCONFIRMED_MESSAGE : sentence,
    reread: !cause.nothingChanged || alsoReread.includes(cause.code),
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
