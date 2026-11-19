// The life of the Super Admin's password inside the confirm dialog (plan: access and roles, Task 22), as a pure reducer so that it is tested without a browser.
//   - the password is in the state while she types and while the call is on its way;
//   - when the answer comes, whatever it is (it worked, or it was refused for any reason), the password is gone: a wrong one is not kept to be sent again by a click, and a right one
//     is not kept after it was used;
//   - closing the dialog empties everything.
// Nothing else holds it: not a log line, not an address, not browser storage.
export interface PasswordDialogState {
  password: string;
  saving: boolean;
  /** The sentence the last answer refused with, or null. */
  error: string | null;
}

export const EMPTY_PASSWORD_DIALOG: PasswordDialogState = {
  password: '',
  saving: false,
  error: null,
};

export type PasswordDialogAction =
  | { type: 'typed'; password: string }
  | { type: 'submitted' }
  | { type: 'answered'; error: string | null }
  | { type: 'closed' };

export function passwordDialogReducer(
  state: PasswordDialogState,
  action: PasswordDialogAction
): PasswordDialogState {
  switch (action.type) {
    case 'typed':
      // typing goes on being ignored while the call is on its way; a new try takes the old refusal away
      return state.saving ? state : { ...state, password: action.password, error: null };
    case 'submitted':
      // nothing is sent for an empty password, and nothing is sent twice
      return state.saving || state.password === ''
        ? state
        : { ...state, saving: true, error: null };
    case 'answered':
      return { password: '', saving: false, error: action.error };
    case 'closed':
      return EMPTY_PASSWORD_DIALOG;
  }
}
