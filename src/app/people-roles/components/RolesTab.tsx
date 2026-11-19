'use client';
import React, { useCallback, useState } from 'react';
import type { SuperRole } from '@/lib/api/types';
import { openIfFree } from '../lib/personFlow';
import { ROLES_NOTE, dialogFor, type RoleAction, type RolesDialog } from '../lib/roles';
import NewRoleDialog from './NewRoleDialog';
import type { TabBodyProps } from './PeopleRolesClient';
import RolesList from './RolesList';
import SwitchRoleDialog from './SwitchRoleDialog';

// The Roles tab (plan: access and roles, Task 24; DESIGN 6.5; the pictures are mockups/2-roles.png, 4-password-confirm.png and 5-phone.png): the roles of the shop and what can be done to them.
// The list, the "+ New role" button, and the dialogs of the buttons of a row. This file owns which dialog is open (one at a time); each dialog does its own steps and, after a write, reads
// the people and the roles again (`reload`, given by the shell).
//   - Edit opens no dialog: it goes to the screen of the role, which the shell opens (`onEdit`, Task 25);
//   - the button is drawn at the top of the panel, under the tabs, like "+ Add person": the heading and the tabs belong to the shell;
//   - an open dialog is never replaced, and nothing goes to the editor from behind one: nothing traps the keyboard behind the overlay, so a button of the list can be pressed while a
//     dialog is up. Both openers go through `openIfFree` (which keeps what is open), and Edit does nothing while a dialog is open.

export interface RolesTabViewProps {
  roles: SuperRole[];
  /** How many ticks there are in all (the length of the catalogue), or 0 when it has not arrived. */
  tickTotal: number;
  onNew: () => void;
  onAction: (action: RoleAction, role: SuperRole) => void;
}

/** The tab as it is drawn with no dialog open (the container below gives it its handlers). */
export function RolesTabView({ roles, tickTotal, onNew, onAction }: RolesTabViewProps) {
  return (
    <div data-testid="roles-tab" className="space-y-4">
      <div className="flex md:justify-end">
        <button
          type="button"
          data-testid="new-role"
          onClick={onNew}
          className="btn-primary w-full justify-center py-2.5 md:w-auto"
        >
          + New role
        </button>
      </div>
      <RolesList roles={roles} tickTotal={tickTotal} onAction={onAction} />
      <p className="text-[13px] text-muted-foreground">{ROLES_NOTE}</p>
    </div>
  );
}

function OpenDialog({
  open,
  roles,
  reload,
  onClose,
}: {
  open: RolesDialog;
  roles: SuperRole[];
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  switch (open.kind) {
    case 'new':
      return <NewRoleDialog roles={roles} copyOf={open.copyOf} reload={reload} onClose={onClose} />;
    case 'switch':
      return <SwitchRoleDialog role={open.role} reload={reload} onClose={onClose} />;
  }
}

export default function RolesTab({
  ticks,
  roles,
  reload,
  onEdit,
}: TabBodyProps & {
  /** Opens the screen of a role (the Edit button). */
  onEdit: (role: SuperRole) => void;
}) {
  const [open, setOpen] = useState<RolesDialog | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const onAction = (action: RoleAction, role: SuperRole) => {
    const next = dialogFor(action, role);
    if (next !== null) setOpen((now) => openIfFree(now, next));
    else if (open === null) onEdit(role);
  };
  return (
    <>
      <RolesTabView
        roles={roles}
        tickTotal={ticks.ticks.length}
        onNew={() => setOpen((now) => openIfFree(now, { kind: 'new', copyOf: '' }))}
        onAction={onAction}
      />
      {open !== null && <OpenDialog open={open} roles={roles} reload={reload} onClose={close} />}
    </>
  );
}
