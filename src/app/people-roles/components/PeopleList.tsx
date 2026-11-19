import React from 'react';
import { Lock } from 'lucide-react';
import type { SuperPerson } from '@/lib/api/types';
import {
  actionLabel,
  lockLine,
  personActions,
  statusLabel,
  type PersonAction,
} from '../lib/people';

// The people of the shop as the picture shows them (mockups/1-people.png and 5-phone.png; plan: access and roles, Task 23): a table with the person, the role, the status and the buttons
// of `personActions`. Below the tablet width (`md`, 768 px) it is not a table but one card for each person, in the same order: the name and the e-mail, the role, the status, the
// buttons. It is the same markup for both: the table parts are drawn as blocks on a phone, and keep their table roles for a screen reader.
//   - the role is shown by its NAME, and a Super Admin by the gold "Super Admin" pill; no role key and no id is in the markup;
//   - a switched-off person is greyed. A Super Admin row has the lock line of `lockLine` where the buttons are not.

const HEADINGS = ['Person', 'Role', 'Status', 'Actions'] as const;

const CELL = 'block md:table-cell py-0.5 md:px-4 md:py-3.5 md:align-middle';
const BUTTON =
  'inline-flex items-center rounded-sm border border-border bg-card px-2.5 py-1.5 text-[13px] font-semibold text-foreground transition-colors hover:border-primary hover:text-primary';
const BUTTON_SWITCH_OFF =
  'inline-flex items-center rounded-sm border border-border bg-card px-2.5 py-1.5 text-[13px] font-semibold text-red-600 transition-colors hover:border-red-300 hover:text-red-700';

function RolePill({ person }: { person: SuperPerson }) {
  return person.is_super_admin ? (
    <span className="inline-block whitespace-nowrap rounded-full border border-primary bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
      Super Admin
    </span>
  ) : (
    <span className="inline-block whitespace-nowrap rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-semibold text-foreground">
      {person.role_name}
    </span>
  );
}

function Status({ person }: { person: SuperPerson }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${person.active ? 'bg-green-600' : 'bg-gray-400'}`}
      />
      {statusLabel(person)}
    </span>
  );
}

function Row({
  person,
  meId,
  onAction,
}: {
  person: SuperPerson;
  meId: string;
  onAction: (action: PersonAction, person: SuperPerson) => void;
}) {
  const actions = personActions(person, meId);
  const line = lockLine(person, meId);
  return (
    <tr
      role="row"
      data-testid="person-row"
      className={`block md:table-row border-b border-border p-3.5 text-foreground last:border-b-0 md:p-0 ${
        person.active ? '' : 'bg-[#faf7f1] text-muted-foreground'
      }`}
    >
      <td role="cell" className={CELL}>
        <span className="block font-semibold">{person.full_name}</span>
        <span className="block text-[13px] text-muted-foreground">{person.email}</span>
      </td>
      <td role="cell" className={CELL}>
        <RolePill person={person} />
      </td>
      <td role="cell" className={CELL}>
        <Status person={person} />
      </td>
      <td role="cell" className={`${CELL} mt-2.5 md:mt-0`}>
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              data-testid={`person-${action}`}
              aria-label={`${actionLabel(action, person)} ${person.full_name}`}
              onClick={() => onAction(action, person)}
              className={action === 'switch' && person.active ? BUTTON_SWITCH_OFF : BUTTON}
            >
              {actionLabel(action, person)}
            </button>
          ))}
          {line && (
            <span
              data-testid="person-lock-line"
              className="inline-flex items-start gap-1.5 text-[13px] text-muted-foreground"
            >
              <Lock size={15} aria-hidden="true" className="mt-[3px] flex-none" />
              {line}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function PeopleList({
  people,
  meId,
  onAction,
}: {
  people: SuperPerson[];
  meId: string;
  onAction: (action: PersonAction, person: SuperPerson) => void;
}) {
  return (
    <div className="jewel-card overflow-hidden">
      <table role="table" data-testid="people-table" className="block w-full md:table">
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
          {people.map((person) => (
            <Row key={person.id} person={person} meId={meId} onAction={onAction} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
