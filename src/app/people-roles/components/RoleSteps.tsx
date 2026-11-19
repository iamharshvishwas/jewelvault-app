'use client';
import React, { useEffect, useReducer } from 'react';
import { api } from '@/lib/api/client';
import { CONFIRMING, flowReducer } from '../lib/personFlow';
import {
  roleChangeConfirmLabel,
  roleChangeSummary,
  roleChangeTitle,
  type RoleChange,
} from '../lib/roleChange';
import { runRoleChange } from '../lib/roleWrite';
import ConfirmPasswordDialog from './ConfirmPasswordDialog';

// What comes after a button or a form of the Roles tab (plan: access and roles, Task 24): the password step for one change. Every write of the tab goes through here. It is `ChangeSteps` of
// the People tab for a role: the same password step and the same way of closing, without the temporary password (a role write gives none).
//   - the password step is ConfirmPasswordDialog, which does not close itself: this closes it when the write went through, and reads the lists again before that (`runRoleChange`).
//     The dialog is done when the flow reducer says `closed`: that, and nothing else, tells `onClose`;
//   - a refusal stays on the password step with the API's sentence (a wrong password is typed again at once; a rule's refusal says what rule, and the lists were read again);
//   - except one that says the role was changed by someone else (`stale`, Task 24b): the lists were read again, so the row behind shows it as it is now, and the step ENDS: a second Confirm
//     would name the old stamp and be refused for ever, and a change made again from the fresh row could go the other way (another browser may have switched the role already). It is
//     closed as after a write, and the tab is told (`onStale`) so that it says why, above the list;
//   - the dialogs are shown one INSTEAD of the other, never one over the other: both of the password step and of a form listen for Escape on the page;
//   - "Cancel" on the password step is `onBack`: the form takes the person back to it with what was typed, a button without a form closes.

export default function RoleSteps({
  change,
  reload,
  onBack,
  onClose,
  onStale,
}: {
  change: RoleChange;
  /** Reads the people and the roles again (`TabBodyProps.reload`). */
  reload: () => Promise<void>;
  onBack: () => void;
  onClose: () => void;
  /** The role was changed by someone else: the step has been closed and the tab shows the notice. */
  onStale: () => void;
}) {
  const [flow, dispatch] = useReducer(flowReducer, CONFIRMING);
  const done = flow.step === 'closed';

  useEffect(() => {
    if (done) onClose();
  }, [done, onClose]);

  if (done) return null;

  const confirm = async (password: string) => {
    const outcome = await runRoleChange(api, reload, change, password);
    if (outcome.stale === true) {
      onStale();
      dispatch({ type: 'closed' });
      return { error: null };
    }
    if (outcome.error !== null) return outcome;
    dispatch({ type: 'written', temporary: null });
    return { error: null };
  };

  return (
    <ConfirmPasswordDialog
      title={roleChangeTitle(change)}
      summary={roleChangeSummary(change).map((line, place) => (
        <p key={place} className={place === 0 ? 'font-semibold' : 'text-muted-foreground'}>
          {line}
        </p>
      ))}
      confirmLabel={roleChangeConfirmLabel(change)}
      onConfirm={confirm}
      onClose={onBack}
    />
  );
}
