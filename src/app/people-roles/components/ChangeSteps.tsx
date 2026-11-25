'use client';
import React, { useEffect, useReducer } from 'react';
import { api } from '@/lib/api/client';
import {
  changeConfirmLabel,
  changeSummary,
  changeTitle,
  type PersonChange,
} from '../lib/personChange';
import { CONFIRMING, flowReducer } from '../lib/personFlow';
import { runChange } from '../lib/personWrite';
import ConfirmPasswordDialog from './ConfirmPasswordDialog';
import TemporaryPasswordDialog from './TemporaryPasswordDialog';

// What comes after a button or a form of the People tab (plan: access and roles, Task 23): the password step for one change, then, when the write gave a temporary password, the dialog
// that shows it once. Every write of the tab goes through here.
//   - the password step is ConfirmPasswordDialog, which does not close itself: this closes it when the write went through, and reads the lists again before that (`runChange`).
//     The dialog is done when the flow reducer says `closed` (a write with nothing to show, or the temporary password copied): that, and nothing else, tells `onClose`;
//   - a refusal stays on the password step with the API's sentence, so that a wrong password is typed again at once;
//   - the dialogs are shown one INSTEAD of the other, never one over the other: both of the password step and of a form listen for Escape on the page;
//   - "Cancel" on the password step is `onBack`: a form takes the person back to it with what was typed, a button without a form closes.

export default function ChangeSteps({
  change,
  reload,
  onBack,
  onClose,
}: {
  change: PersonChange;
  /** Reads the people and the roles again (`TabBodyProps.reload`). */
  reload: () => Promise<void>;
  onBack: () => void;
  onClose: () => void;
}) {
  const [flow, dispatch] = useReducer(flowReducer, CONFIRMING);
  const done = flow.step === 'closed';

  useEffect(() => {
    if (done) onClose();
  }, [done, onClose]);

  if (done) return null;
  if (flow.step === 'temporary')
    return (
      <TemporaryPasswordDialog
        temporary={flow.temporary}
        onDone={() => dispatch({ type: 'closed' })}
      />
    );

  const confirm = async (password: string) => {
    const outcome = await runChange(api, reload, change, password);
    if (outcome.error !== null) return { error: outcome.error };
    dispatch({ type: 'written', temporary: outcome.temporary });
    return { error: null };
  };

  return (
    <ConfirmPasswordDialog
      title={changeTitle(change)}
      summary={changeSummary(change).map((line, place) => (
        <p key={place} className={place === 0 ? 'font-semibold' : 'text-muted-foreground'}>
          {line}
        </p>
      ))}
      confirmLabel={changeConfirmLabel(change)}
      onConfirm={confirm}
      onClose={onBack}
    />
  );
}
