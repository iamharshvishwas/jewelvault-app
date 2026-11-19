// What is about to happen to a role, in words (plan: access and roles, Task 24; the picture is mockups/4-password-confirm.png): the two writes of the Roles tab that go through the password
// step as one value each, and the title, the sentences and the button of that step. Plain TypeScript with no React; `roleWrite.ts` does the write. (Editing a role's name, description and
// ticks is the Edit role screen, Task 25.)
//   - the first sentence says exactly what will happen ("Create the role Cashier, starting from Biller"); a second says what follows from it;
//   - the values are those that will be saved: the name without the spaces around it and with the white space inside it folded, the role to start from by its name. A role is named in
//     words and never by its key.
import type { SuperRole } from '@/lib/api/types';
import { cleanRoleName, type NewRoleValues } from './roles';

export type RoleChange =
  | {
      kind: 'create';
      /** The key of the role to start from. */
      copy_of: string;
      /** Its name, for the words. */
      copyName: string;
      name: string;
      description: string;
    }
  | { kind: 'switch'; role: SuperRole; active: boolean };

export function newRoleChange(v: NewRoleValues, roles: readonly SuperRole[]): RoleChange {
  return {
    kind: 'create',
    copy_of: v.copy_of,
    copyName: roles.find((r) => r.key === v.copy_of)?.name ?? '',
    name: cleanRoleName(v.name),
    description: v.description.trim(),
  };
}

/** Switches the role the other way from the way it is now. */
export function switchRoleChange(role: SuperRole): RoleChange {
  return { kind: 'switch', role, active: !role.active };
}

export function roleChangeTitle(c: RoleChange): string {
  switch (c.kind) {
    case 'create':
      return 'Create this role?';
    case 'switch':
      return c.active ? 'Switch on this role?' : 'Switch off this role?';
  }
}

export function roleChangeConfirmLabel(c: RoleChange): string {
  switch (c.kind) {
    case 'create':
      return 'Confirm and create';
    case 'switch':
      return c.active ? 'Confirm and switch on' : 'Confirm and switch off';
  }
}

/** The sentences of the password step, one paragraph each: what will happen, then what follows from it. */
export function roleChangeSummary(c: RoleChange): string[] {
  switch (c.kind) {
    case 'create':
      return [
        `Create the role ${c.name}, starting from ${c.copyName}`,
        'You can then change its ticks with Edit.',
      ];
    case 'switch':
      // a role that is off cannot be given to anybody (API Task 14: the role of a person must be active), and that is the one thing that follows from switching it
      return c.active
        ? [`Switch on the role ${c.role.name}`, 'People can be given this role again.']
        : [
            `Switch off the role ${c.role.name}`,
            'Nobody can be given this role while it is switched off.',
          ];
  }
}
