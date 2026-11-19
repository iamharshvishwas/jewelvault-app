// What is about to happen to a person, in words (plan: access and roles, Task 23; the picture is mockups/4-password-confirm.png): the five writes of the People tab as one value each, and
// the title, the sentences and the button of the password step that comes before every one of them. Plain TypeScript with no React; `personWrite.ts` does the write.
//   - the first sentence says exactly what will happen ("Add Meena Shah (meena@example.test) as Biller": the e-mail too, since this is the last look before the login exists); a second
//     says what follows from it, where something does (a sign-out, a temporary password). Sign-outs are counted in devices, the word of the temporary password dialog;
//   - the values are those that will be saved: the name without the spaces around it, the e-mail in lower case, the role by its name. A role is named in words and never by its key.
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import {
  SCREEN_RELOADS,
  editChanges,
  normalizeEmail,
  type EditValues,
  type NewPersonValues,
  type PersonEdits,
} from './people';

export type PersonChange =
  | { kind: 'add'; full_name: string; email: string; role: string; roleName: string }
  | { kind: 'edit'; person: SuperPerson; changes: PersonEdits; self: boolean }
  | { kind: 'role'; person: SuperPerson; role: string; roleName: string }
  | { kind: 'switch'; person: SuperPerson; active: boolean }
  | { kind: 'reset'; person: SuperPerson };

const nameOf = (roles: readonly SuperRole[], key: string) =>
  roles.find((r) => r.key === key)?.name ?? '';

export function newPersonChange(v: NewPersonValues, choices: readonly SuperRole[]): PersonChange {
  return {
    kind: 'add',
    full_name: v.full_name.trim(),
    email: normalizeEmail(v.email),
    role: v.role,
    roleName: nameOf(choices, v.role),
  };
}

/** `self` is true when the row is the caller's own: only her other sessions end when she changes her e-mail (R11). */
export function editPersonChange(person: SuperPerson, v: EditValues, meId: string): PersonChange {
  return { kind: 'edit', person, changes: editChanges(person, v), self: person.id === meId };
}

export function rolePersonChange(
  person: SuperPerson,
  role: string,
  choices: readonly SuperRole[]
): PersonChange {
  return { kind: 'role', person, role, roleName: nameOf(choices, role) };
}

/** Switches the person the other way from the way they are now. */
export function switchPersonChange(person: SuperPerson): PersonChange {
  return { kind: 'switch', person, active: !person.active };
}

export function resetPersonChange(person: SuperPerson): PersonChange {
  return { kind: 'reset', person };
}

export function changeTitle(c: PersonChange): string {
  switch (c.kind) {
    case 'add':
      return 'Add this person?';
    case 'edit':
      return 'Save these changes?';
    case 'role':
      return "Change this person's role?";
    case 'switch':
      return c.active ? 'Switch on this person?' : 'Switch off this person?';
    case 'reset':
      return "Reset this person's password?";
  }
}

export function changeConfirmLabel(c: PersonChange): string {
  switch (c.kind) {
    case 'add':
      return 'Confirm and add';
    case 'edit':
      return 'Confirm and save';
    case 'role':
      return 'Confirm and change role';
    case 'switch':
      return c.active ? 'Confirm and switch on' : 'Confirm and switch off';
    case 'reset':
      return 'Confirm and reset';
  }
}

/** The sentences of the password step, one paragraph each: what will happen, then what follows from it. */
export function changeSummary(c: PersonChange): string[] {
  switch (c.kind) {
    case 'add':
      return [
        `Add ${c.full_name} (${c.email}) as ${c.roleName}`,
        'A temporary password is shown once. They must change it the first time they sign in.',
      ];
    case 'role':
      return [
        `Change the role of ${c.person.full_name} to ${c.roleName}`,
        `The change works on their very next click. ${SCREEN_RELOADS}`,
      ];
    case 'switch':
      return c.active
        ? [`Switch on ${c.person.full_name}`, 'They can sign in again.']
        : [
            `Switch off ${c.person.full_name}`,
            'They are signed out at once and cannot sign in until you switch them on again.',
          ];
    case 'reset':
      return [
        `Reset the password of ${c.person.full_name}`,
        'A new temporary password is shown once. They are signed out everywhere and must choose a new password when they sign in.',
      ];
    case 'edit':
      return editSummary(c);
  }
}

function editSummary(c: Extract<PersonChange, { kind: 'edit' }>): string[] {
  const { full_name: name, email } = c.changes;
  const who = c.person.full_name;
  const lines: string[] = [];
  if (name !== undefined && email !== undefined)
    lines.push(`Change the name of ${who} to ${name} and the e-mail to ${email}`);
  else if (name !== undefined) lines.push(`Change the name of ${who} to ${name}`);
  else if (email !== undefined) lines.push(`Change the e-mail of ${who} to ${email}`);
  // a new e-mail ends sessions (R11): every session of the person, or only the other ones when it is her own login
  if (email !== undefined)
    lines.push(
      c.self
        ? 'Your other devices are signed out. This one stays.'
        : 'They are signed out everywhere and must sign in with the new e-mail.'
    );
  return lines;
}
