'use client';
import React, { useCallback, useState } from 'react';
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import { useSession } from '@/lib/authStore';
import type { PersonAction } from '../lib/people';
import AddPersonDialog from './AddPersonDialog';
import ChangeRoleDialog from './ChangeRoleDialog';
import EditPersonDialog from './EditPersonDialog';
import PeopleList from './PeopleList';
import type { TabBodyProps } from './PeopleRolesClient';
import ResetPasswordDialog from './ResetPasswordDialog';
import SwitchPersonDialog from './SwitchPersonDialog';

// The People tab (plan: access and roles, Task 23; DESIGN 6.5; the pictures are mockups/1-people.png, 4-password-confirm.png and 5-phone.png): who has a login and what they can be told to
// do. The list, the "+ Add person" button, and the dialogs of the buttons of a row. This file owns which dialog is open (one at a time); each dialog does its own steps and, after a write,
// reads the people and the roles again (`reload`, given by the shell).
//   - the caller's own id comes from the signed-in session (`useSession`), the one place the screen reads who is signed in: her own row is the one that has Edit only (R12);
//   - the button is drawn at the top of the panel, under the tabs: the heading and the tabs belong to the shell.

/** Which dialog is open: the add form, or the dialog of one button of one row. */
type Open = { kind: 'add' } | { kind: PersonAction; person: SuperPerson };

export interface PeopleTabViewProps {
  people: SuperPerson[];
  /** The id of the person who is signed in ('' when nobody is). */
  meId: string;
  onAdd: () => void;
  onAction: (action: PersonAction, person: SuperPerson) => void;
}

/** The tab as it is drawn with no dialog open (the container below gives it its handlers). */
export function PeopleTabView({ people, meId, onAdd, onAction }: PeopleTabViewProps) {
  return (
    <div data-testid="people-tab" className="space-y-4">
      <div className="flex md:justify-end">
        <button
          type="button"
          data-testid="add-person"
          onClick={onAdd}
          className="btn-primary w-full justify-center py-2.5 md:w-auto"
        >
          + Add person
        </button>
      </div>
      {people.length === 0 ? (
        <p data-testid="people-empty" className="jewel-card p-4 text-sm text-muted-foreground">
          Nobody has a login yet.
        </p>
      ) : (
        <PeopleList people={people} meId={meId} onAction={onAction} />
      )}
      <p className="text-[13px] text-muted-foreground">
        Nothing is ever deleted. A switched-off person cannot sign in; you can switch them on again.
      </p>
    </div>
  );
}

function OpenDialog({
  open,
  meId,
  roles,
  reload,
  onClose,
}: {
  open: Open;
  meId: string;
  roles: SuperRole[];
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  switch (open.kind) {
    case 'add':
      return <AddPersonDialog roles={roles} reload={reload} onClose={onClose} />;
    case 'edit':
      return (
        <EditPersonDialog person={open.person} meId={meId} reload={reload} onClose={onClose} />
      );
    case 'role':
      return (
        <ChangeRoleDialog person={open.person} roles={roles} reload={reload} onClose={onClose} />
      );
    case 'reset':
      return <ResetPasswordDialog person={open.person} reload={reload} onClose={onClose} />;
    case 'switch':
      return <SwitchPersonDialog person={open.person} reload={reload} onClose={onClose} />;
  }
}

export default function PeopleTab({ people, roles, reload }: TabBodyProps) {
  const { session } = useSession();
  const meId = session?.userId ?? '';
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <>
      <PeopleTabView
        people={people}
        meId={meId}
        onAdd={() => setOpen({ kind: 'add' })}
        onAction={(action, person) => setOpen({ kind: action, person })}
      />
      {open !== null && (
        <OpenDialog open={open} meId={meId} roles={roles} reload={reload} onClose={close} />
      )}
    </>
  );
}
