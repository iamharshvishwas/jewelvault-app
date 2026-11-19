'use client';
import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { api } from '@/lib/api/client';
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import { readAgain } from '../lib/afterWrite';
import {
  draftReducer,
  infoOf,
  saveOf,
  seedOf,
  settle,
  type DraftAction,
  type Notice,
} from '../lib/editorDraft';
import { roleEditConfirmLabel, roleEditTitle } from '../lib/editWords';
import { runRoleEdit, type RoleEdit } from '../lib/roleEdit';
import type { SuperTicks } from '../lib/superStore';
import ConfirmPasswordDialog from './ConfirmPasswordDialog';
import EditRoleView, { type EditorActions } from './EditRoleView';
import type { TabBodyProps } from './PeopleRolesClient';
import RoleEditSummary from './RoleEditSummary';

// The Edit role screen (plan: access and roles, Task 25; DESIGN 6.5; the pictures are mockups/3-edit-role.png, 4-password-confirm.png and 5-phone.png): the name, what the role is for and
// the ticks of one role, with the password step on Save. The shell shows it in place of the list of roles, for the role it was asked to open (`roleKey`); `EditRoleView` draws it.
//   - the role is read from the list the screen holds now, by its key; a role that is not in the list any more (it should never be: nothing is deleted) takes her back to the list;
//   - what she changes is a draft (`draftReducer`) made from a saved copy of the role. The copy changes only when she saves (the answer of the API), when she asks to reload (the screen
//     starts again from the list as it is then: `EditRole` draws a new `Editor`), and when the first write of a save went through and the second did not. A list that is read again
//     meanwhile does not touch a draft with edits: a save from an older copy is refused as stale, and that is how a change made by someone else is never undone without a word;
//   - Save goes to the password step (`ConfirmPasswordDialog`, shown over the page: the page behind it is off) with what is about to happen in words. `runRoleEdit` does the one or two
//     writes with the password in their bodies. A wrong password stays on the step with its sentence. Any other outcome closes the step: saved (the draft is the answer, "Saved."), a
//     role changed by someone else (her edits stay, with "Reload" to discard them), or any other refusal in a line on the page (the API's own sentence);
//   - the tab strip is locked while she has edits that are not saved or the password step is open (`onBusy`, the shell's `nextTab`): changing tabs would lose them;
//   - the page is not a dialog and listens for no key of its own: only the password step listens for Escape, and the question "Leave without saving?" is a line on the page.

function Editor({
  ticks,
  people,
  roles,
  live,
  reload,
  onBusy,
  onBack,
  onReloaded,
}: {
  ticks: SuperTicks;
  people: SuperPerson[];
  roles: SuperRole[];
  live: SuperRole;
  reload: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onBack: () => void;
  /** The lists were read again because she asked for it: start the screen again from them. */
  onReloaded: () => void;
}) {
  const [draft, dispatch] = useReducer(draftReducer, live, seedOf);
  const [confirming, setConfirming] = useState<RoleEdit | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const info = useMemo(() => infoOf(draft, ticks.ticks, roles), [draft, ticks.ticks, roles]);

  const busy = !live.fixed && (info.dirty || confirming !== null);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  const closeStep = useCallback(() => setConfirming(null), []);

  const change = (action: DraftAction) => {
    // "Saved." is about what was saved: the next change makes it untrue. A refusal stays until it is dealt with. Changing something is also the answer "keep editing" to the question.
    setNotice((now) => (now?.kind === 'saved' ? null : now));
    setLeaving(false);
    dispatch(action);
  };

  const confirm = async (password: string) => {
    if (confirming === null) return { error: null };
    const {
      action,
      notice: next,
      stepError,
    } = settle(await runRoleEdit(api, reload, confirming, password));
    // a password that was refused is typed again on the step; every other outcome closes it
    if (stepError !== null) return { error: stepError };
    if (action !== null) dispatch(action);
    setNotice(next);
    setConfirming(null);
    return { error: null };
  };

  const on: EditorActions = {
    name: (value) => change({ type: 'name', value }),
    description: (value) => change({ type: 'description', value }),
    toggle: (key, wanted) => change({ type: 'tick', catalogue: ticks.ticks, key, on: wanted }),
    understood: (wanted) => change({ type: 'understood', confirm: info.confirm, on: wanted }),
    save: () => {
      const edit = saveOf(draft, ticks.ticks, roles);
      if (edit === null) return;
      setNotice(null);
      setLeaving(false);
      setConfirming(edit);
    },
    leave: () => (info.dirty ? setLeaving(true) : onBack()),
    leaveForGood: onBack,
    keepEditing: () => setLeaving(false),
    reload: async () => {
      await readAgain(reload);
      onReloaded();
    },
  };

  return (
    <>
      <EditRoleView
        catalogue={ticks}
        role={live}
        people={people}
        draft={draft}
        info={info}
        notice={notice}
        leaving={leaving}
        frozen={confirming !== null}
        on={on}
      />
      {confirming !== null && (
        <ConfirmPasswordDialog
          title={roleEditTitle(confirming)}
          summary={<RoleEditSummary edit={confirming} catalogue={ticks.ticks} />}
          confirmLabel={roleEditConfirmLabel}
          onConfirm={confirm}
          onClose={closeStep}
        />
      )}
    </>
  );
}

export default function EditRole({
  ticks,
  people,
  roles,
  reload,
  onBusy,
  roleKey,
  onBack,
}: TabBodyProps & {
  /** The key of the role to edit. */
  roleKey: string;
  /** Back to the list of roles. */
  onBack: () => void;
}) {
  const live = roles.find((role) => role.key === roleKey);
  // each "Reload" gives a new round, and with it a new Editor that starts from the role as the list holds it then
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (live === undefined) onBack();
  }, [live, onBack]);
  if (live === undefined) return null;
  return (
    <Editor
      key={round}
      onReloaded={() => setRound((now) => now + 1)}
      ticks={ticks}
      people={people}
      roles={roles}
      live={live}
      reload={reload}
      onBusy={onBusy}
      onBack={onBack}
    />
  );
}
