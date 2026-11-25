import React, { useId } from 'react';
import { Lock } from 'lucide-react';
import type { SuperRole } from '@/lib/api/types';
import {
  actionLabel,
  lockLine,
  peopleLine,
  roleActions,
  roleSummary,
  switchOffReason,
  type RoleAction,
} from '../lib/roles';

// The roles of the shop as the picture shows them (mockups/2-roles.png; plan: access and roles, Task 24): a table with the role, the people who have it, the ticks that are on and the
// buttons of `roleActions`. Below the tablet width (`md`, 768 px) it is not a table but one card for each role, in the same order: the name and what the role is for, the people, the
// ticks, the buttons. It is the same markup for both, as in the People list: the table parts are drawn as blocks on a phone, and keep their table roles for a screen reader.
//   - a role is shown by its NAME and what it is for; no role key and no stamp is in the markup. The Owner has the "Fixed" pill and the lock line where the buttons are not;
//   - a switched-off role is greyed and says so (and has Switch on);
//   - Switch off is disabled while people have the role, and the reason is written next to it, tied to the button with `aria-describedby`: a phone has no tooltip, and a disabled button
//     cannot be focused, so the reason is a line in the row and not a `title`.

const HEADINGS = ['Role', 'People', 'Ticks on', 'Actions'] as const;

const CELL = 'block md:table-cell py-0.5 md:px-4 md:py-3.5 md:align-middle';
// the two short cells never wrap on a table ("1 person", "32 of 32 ticks" are one line each, as in the picture), and sit side by side on a card
const SHORT_CELL =
  'inline-block mr-4 py-0.5 md:mr-0 md:table-cell md:px-4 md:py-3.5 md:align-middle md:whitespace-nowrap';
const BUTTON =
  'inline-flex items-center rounded-sm border border-border bg-card px-2.5 py-1.5 text-[13px] font-semibold text-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-[0.45] disabled:hover:border-border disabled:hover:text-foreground';

function Marks({ role }: { role: SuperRole }) {
  return (
    <>
      {role.fixed && (
        <span className="inline-block whitespace-nowrap rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-semibold text-foreground">
          Fixed
        </span>
      )}
      {!role.active && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-gray-400" />
          Switched off
        </span>
      )}
    </>
  );
}

function Row({
  role,
  tickTotal,
  onAction,
}: {
  role: SuperRole;
  tickTotal: number;
  onAction: (action: RoleAction, role: SuperRole) => void;
}) {
  const reasonId = useId();
  const line = lockLine(role);
  const reason = switchOffReason(role);
  return (
    <tr
      role="row"
      data-testid="role-row"
      className={`block md:table-row border-b border-border p-3.5 text-foreground last:border-b-0 md:p-0 ${
        role.active ? '' : 'bg-[#faf7f1] text-muted-foreground'
      }`}
    >
      <td role="cell" className={CELL}>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="min-w-0 font-semibold break-words [overflow-wrap:anywhere]">
            {role.name}
          </span>
          <Marks role={role} />
        </span>
        {role.description !== '' && (
          <span className="block text-[13px] text-muted-foreground break-words [overflow-wrap:anywhere]">
            {role.description}
          </span>
        )}
      </td>
      <td role="cell" className={SHORT_CELL}>
        {peopleLine(role.people)}
      </td>
      <td role="cell" className={SHORT_CELL}>
        {roleSummary(role, tickTotal)}
      </td>
      <td role="cell" className={`${CELL} mt-2.5 md:mt-0`}>
        <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
          {roleActions(role).map((action) => {
            const blocked = action === 'switch' && reason !== null;
            return (
              <button
                key={action}
                type="button"
                data-testid={`role-${action}`}
                aria-label={`${actionLabel(action, role)} ${role.name}`}
                disabled={blocked}
                aria-describedby={blocked ? reasonId : undefined}
                onClick={() => onAction(action, role)}
                className={BUTTON}
              >
                {actionLabel(action, role)}
              </button>
            );
          })}
          {line && (
            <span
              data-testid="role-lock-line"
              className="inline-flex items-start gap-1.5 text-[13px] text-muted-foreground md:whitespace-nowrap"
            >
              <Lock size={15} aria-hidden="true" className="mt-[3px] flex-none" />
              {line}
            </span>
          )}
        </div>
        {reason !== null && (
          <p
            id={reasonId}
            data-testid="role-switch-reason"
            className="mt-1.5 text-[13px] text-muted-foreground md:max-w-[17rem]"
          >
            {reason}
          </p>
        )}
      </td>
    </tr>
  );
}

export default function RolesList({
  roles,
  tickTotal,
  onAction,
}: {
  roles: SuperRole[];
  /** How many ticks there are in all (the catalogue), or 0 when it has not arrived. */
  tickTotal: number;
  onAction: (action: RoleAction, role: SuperRole) => void;
}) {
  return (
    <div className="jewel-card overflow-hidden">
      <table role="table" data-testid="roles-table" className="block w-full md:table">
        <thead role="rowgroup" className="hidden md:table-header-group">
          <tr role="row" className="border-b border-border bg-secondary">
            {HEADINGS.map((heading) => (
              <th
                key={heading}
                role="columnheader"
                scope="col"
                className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="block md:table-row-group">
          {roles.map((role) => (
            <Row key={role.key} role={role} tickTotal={tickTotal} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
