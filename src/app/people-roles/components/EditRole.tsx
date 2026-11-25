'use client';
import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { api } from '@/lib/api/client';
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import { readAgain, readRoleAgain } from '../lib/afterWrite';
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
import { shouldWarnOnUnload, warnBeforeUnload } from '../lib/unloadGuard';
import ConfirmPasswordDialog from './ConfirmPasswordDialog';
import EditRoleView, { type EditorActions } from './EditRoleView';
import type { TabBodyProps } from './PeopleRolesClient';
import RoleEditSummary from './RoleEditSummary';

// The Edit role screen (plan: access and roles, Task 25; DESIGN 6.5; the pictures are mockups/3-edit-role.png, 4-password-confirm.png and 5-phone.png): the name, what the role is for and
// the ticks of one role, with the password step on Save. The shell shows it in place of the list of roles, for the role it was asked to open (`roleKey`); `EditRoleView` draws it.
//   - the role is read from the list the screen holds now, by its key; a role that is not in the list any more (it should never be: nothing is deleted) takes her back to the list;
//   - what she changes is a draft (`draftReducer`) made from a saved copy of the role. The copy changes only when she saves (the answer of the API), when she asks to reload (the editor reads
//     the role itself, `readRoleAgain`, and starts again from what it read, so it waits for no drawing of the lists; when the role cannot be read it changes nothing but its alert), and when
//     the first write of a save went through and the second did not. A list that is read again meanwhile does not touch a draft with edits: a save from an older copy is refused as stale,
//     and that is how a change made by someone else is never undone without a word;
//   - Save goes to the password step (`ConfirmPasswordDialog`, shown over the page: the page behind it is off) with what is about to happen in words. `runRoleEdit` does the one or two
//     writes with the password in their bodies. A wrong password stays on the step with its sentence. Any other outcome closes the step: saved (the draft is the answer, "Saved."), a
//     role changed by someone else (her edits stay, with "Reload" to discard them; when the name or the description of this save is already live, the alert says so first), or any
//     other refusal in a line on the page (the API's own sentence; a name that another role has, which only the API can tell, reads "Another role already has this name.");
//   - the tab strip is locked while she has edits that are not saved or the password step is open (`onBusy`, the shell's `nextTab`): changing tabs would lose them;
//   - a reload or closing the tab, which the shell cannot lock, asks first while she has edits that are not saved (`beforeunload`, `unloadGuard.ts`, Task 24b); the sidebar and the browser's
//     Back are moves inside the page and are not covered;
//   - the page is not a dialog and listens for no key of its own: only the password step listens for Escape, and the question "Leave without saving?" is a line on the page.

function Editor({
  ticks,
  people,
  roles,
  live,
  reload,
  onBusy,
  onBack,
}: {
  ticks: SuperTicks;
  people: SuperPerson[];
  roles: SuperRole[];
  live: SuperRole;
  reload: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onBack: () => void;
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

  // a reload or closing the tab asks first while there are edits that are not saved; the cleanup takes the listener away when she has none, and when the editor goes
  useEffect(() => {
    if (shouldWarnOnUnload(info.dirty)) window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [info.dirty]);

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
    } = settle(await runRoleEdit(api, reload, confirming, password), confirming);
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
      // the role as it is saved now, read here and used as it is read: the new start waits for no drawing of the lists. A read that fails changes nothing but the alert, which says so
      const fresh = await readRoleAgain(api, live.key);
      if (fresh === null) {
        setNotice((now) => (now?.kind === 'stale' ? { ...now, readFailed: true } : now));
        return;
      }
      await readAgain(reload);
      dispatch({ type: 'seed', role: fresh });
      setNotice(null);
      setLeaving(false);
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
  useEffect(() => {
    if (live === undefined) onBack();
  }, [live, onBack]);
  if (live === undefined) return null;
  return (
    <Editor
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
