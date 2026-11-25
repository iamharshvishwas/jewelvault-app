// Forgot password by e-mail, the website side (Completion-Plan/password-help-2026-11-26/DESIGN.md, part 2): the two public calls of the API, the token in the address, and the
// words of the two screens.
//
//   POST /v1/auth/forgot-password  { email }                  -> 202 { ok: true } for every e-mail (known or not), or 503 JV_UNAVAILABLE `mail_not_set_up`
//   POST /v1/auth/reset-password   { token, new_password }    -> 200 { ok: true }, or 422 JV_INVALID_INPUT on the field `token` or `new_password`
//
// Both are public: no session and no cookie is needed, and both go through the one API client of the site (src/lib/api/client.ts), so the address, the headers and the plain
// messages of every failure are the ones of every other call. Like `login` they save no business data (`readOnly`): a failure never says "saved".
// The token is a secret. It travels in the body of the one call that uses it, and nowhere else: it is not in an address, a header, a message or a log line made here.
// A saved password also makes the session store look at this browser's session again (see `resetPassword`).
import { api as siteApi, isApiError, type ApiClient } from '@/lib/api/client';
import { newPasswordReason, reviewRole } from '@/lib/authStore';

// ------------------------------------------------------------------------------------------------ the words of the screens

/** What the forgot screen says after Send link, whatever the e-mail was (the screen never tells whether it has a login). */
export const LINK_SENT_MESSAGE =
  'If this e-mail has a login, a link is on its way. It works once, within 30 minutes. No mail in 5 minutes (look in Spam too)? Ask the Super Admin to reset your password from People & Roles.';
/** What the reset screen says when the link is no good: no token in the address, or the API refused it. */
export const BAD_LINK_MESSAGE = 'This link has expired or was already used. Ask for a new one.';
/** What the reset screen says once the password is saved. */
export const PASSWORD_CHANGED_MESSAGE = 'Your password is changed. Sign in with it.';
/** The API's own sentence when it has no mail settings (503, details.reason `mail_not_set_up`). The client's map would turn that 503 into "cannot reach the server". */
export const MAIL_NOT_SET_UP_MESSAGE =
  'E-mail is not set up here. Ask the Super Admin to reset your password.';

// ------------------------------------------------------------------------------------------------ the address

/** A token is `randomBytes(32).toString('base64url')`: 43 characters. The window is wide on purpose; anything else is not a link of ours. */
const TOKEN_IN_HASH = /^#t=([A-Za-z0-9_-]{20,100})$/;

/** The token of a reset link: `#t=<token>`, base64url only, 20 to 100 characters. Anything else (nothing, a short or a long text, other characters) is null. */
export function tokenFromHash(hash: string): string | null {
  return TOKEN_IN_HASH.exec(hash)?.[1] ?? null;
}

/**
 * The two pages that open whatever the session state (the layout shows them before its loading, sign-in and role checks): a person who forgot the password has no session, and one who
 * is signed in on this browser must still see the page of the link they opened. The path is the one `usePathname` gives, with or without a trailing slash, a query or a hash.
 */
export function standalonePathScreen(pathname: string): 'forgot' | 'reset' | null {
  const path = (pathname.split(/[?#]/)[0] ?? '').replace(/\/+$/, '');
  if (path === '/forgot-password') return 'forgot';
  if (path === '/reset-password') return 'reset';
  return null;
}

// ------------------------------------------------------------------------------------------------ the calls

/**
 * Asks for a link. `{ ok: true }` is the 202, which comes for every e-mail; the screen then says the same sentence whatever happened. The only refusal with words of its own is the
 * API's "e-mail is not set up here"; any other failure is the plain message of the client's map.
 */
export async function requestResetLink(
  email: string,
  client: ApiClient = siteApi
): Promise<{ ok: true } | { error: string }> {
  try {
    await client.post('/v1/auth/forgot-password', { email: email.trim() }, { readOnly: true });
    return { ok: true };
  } catch (error) {
    if (!isApiError(error)) return { error: 'Could not send the link. Try again.' };
    if (error.code === 'JV_UNAVAILABLE' && error.details.reason === 'mail_not_set_up')
      return { error: MAIL_NOT_SET_UP_MESSAGE };
    return { error: error.message };
  }
}

/**
 * Saves the new password with the link's token. A refused token is the screen's own sentence and `field: 'token'` (the link is no good, so the form goes); a refused new password is
 * the API's reason, said the way the change-password screen says it, and `field: 'new_password'`. Any other failure is the plain message of the client's map, with no field.
 *
 * Once it is saved the API has ended every session of that login, and this browser may hold one of them (the person opened the link while signed in as that login). So on the 200 the
 * session store is made to look at its session at once (`recheckSession`, by default the store's `reviewRole`: it asks `me`): a 401 shows sign-in, as it would at the next poll but
 * without the minutes in between, and a browser signed in as another login gets that login's own answer and keeps it. Nothing is waited for: the screen says "changed" at once.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  client: ApiClient = siteApi,
  recheckSession: () => unknown = reviewRole
): Promise<{ ok: true } | { error: string; field?: 'token' | 'new_password' }> {
  try {
    await client.post(
      '/v1/auth/reset-password',
      { token, new_password: newPassword },
      { readOnly: true }
    );
  } catch (error) {
    if (!isApiError(error)) return { error: 'Could not change the password. Try again.' };
    if (error.code === 'JV_INVALID_INPUT') {
      if (error.details.field === 'token') return { error: BAD_LINK_MESSAGE, field: 'token' };
      if (error.details.field === 'new_password')
        return { error: newPasswordReason(error.message), field: 'new_password' };
    }
    return { error: error.message };
  }
  void recheckSession();
  return { ok: true };
}
