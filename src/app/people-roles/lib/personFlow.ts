// The steps of a dialog after its password step (plan: access and roles, Task 23), as a pure reducer so that it is tested without a browser.
//   - `confirm`: the password step is up; the write has not gone through;
//   - `temporary`: a person was added or a password reset, and the temporary password is on screen. It is in this state and nowhere else, and it is shown once;
//   - `closed`: the dialog is done. Closing empties the state: nothing of a temporary password is left, and a late answer cannot bring it back.
import type { TemporaryPassword } from './personWrite';

export type FlowState =
  | { step: 'confirm' }
  | { step: 'temporary'; temporary: TemporaryPassword }
  | { step: 'closed' };

export type FlowAction =
  /** The write went through: with a temporary password to show once, or with nothing to show (an edit, a role, a switch). */
  { type: 'written'; temporary: TemporaryPassword | null } | { type: 'closed' };

export const CONFIRMING: FlowState = { step: 'confirm' };
const CLOSED: FlowState = { step: 'closed' };

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'written':
      // only the password step can be answered; a second answer, or one that comes after the dialog was closed, changes nothing
      if (state.step !== 'confirm') return state;
      return action.temporary === null
        ? CLOSED
        : { step: 'temporary', temporary: action.temporary };
    case 'closed':
      return CLOSED;
  }
}
