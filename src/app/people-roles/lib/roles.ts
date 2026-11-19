// The rules of the Roles tab (plan: access and roles, Task 24; DESIGN 6.5 and 6.6; API Task 13), as plain TypeScript with no React: which buttons a role has, when it can be switched off and
// why not, the words of a row, and what the New role form checks before it goes on to the password step. tests/unit/people-roles-roles.test.ts drives this file directly.
//   - the Owner role is fixed (DESIGN guardrail 1): its row has no button and says why. It can still be the role a new one starts from (the API refuses every write on it except being
//     copied), which is done from "+ New role";
//   - every other role has Edit, Copy and one button that switches it off or on. Switching OFF is allowed when nobody holds the role (guardrail 4; `people` counts the ACTIVE logins on it):
//     the button is then disabled and the row says why, in words. Switching ON is always allowed;
//   - the checks of the New role form are the ones the API makes (API Task 13, `cleanRoleName`: a name is trimmed, white space inside it is folded, and it is 1 to 40 characters; a
//     description is 200 at most), so that a mistake is shown on the form and not after the password was typed. A name that another role has already is only known to the API: its own
//     sentence is shown as it comes.
import type { SuperRole } from '@/lib/api/types';

export type RoleAction = 'edit' | 'copy' | 'switch';

/** The buttons of a row, in the order they are drawn. The Owner has none: it is fixed. */
export function roleActions(r: SuperRole): RoleAction[] {
  return r.fixed ? [] : ['edit', 'copy', 'switch'];
}

/** Whether a role may be switched off: it is on, nobody holds it, and it is not the Owner. (Switching ON is always allowed.) */
export function canSwitchOff(r: SuperRole): boolean {
  return r.active && r.people === 0 && !r.fixed;
}

/** "1 person", "0 people", "3 people". */
export function peopleLine(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

/** Why Switch off is disabled on a role that is on, or null when it is not (it can be switched off, it is the Owner, or it is off already). */
export function switchOffReason(r: SuperRole): string | null {
  if (!r.active || r.fixed || canSwitchOff(r)) return null;
  return `${peopleLine(r.people)} ${r.people === 1 ? 'has' : 'have'} this role. Give them another role first.`;
}

/** The words of a button: the same as the picture (mockups/2-roles.png). */
export function actionLabel(action: RoleAction, r: SuperRole): string {
  switch (action) {
    case 'edit':
      return 'Edit';
    case 'copy':
      return 'Copy';
    case 'switch':
      return r.active ? 'Switch off' : 'Switch on';
  }
}

/** Why the Owner row has no button, or null for every other role. The words are the picture's. */
export function lockLine(r: SuperRole): string | null {
  return r.fixed ? 'Cannot be changed or switched off' : null;
}

/** "3 of 32 ticks": the ticks that are on, out of the ticks there are. Without the catalogue (no total) it says only how many the role has. */
export function roleSummary(r: SuperRole, tickTotal: number): string {
  const on = r.ticks.length;
  if (tickTotal > 0) return `${on} of ${tickTotal} ticks`;
  return on === 1 ? '1 tick' : `${on} ticks`;
}

/** The note under the list: the picture's words. */
export const ROLES_NOTE =
  'A role can be switched off only when nobody has it. Nothing is ever deleted.';

// ---- the New role form

export interface NewRoleValues {
  /** The key of the role to start from. */
  copy_of: string;
  name: string;
  description: string;
}

const NAME_MAX = 40;
const DESCRIPTION_MAX = 200;

export const COPY_OF_REQUIRED = 'Choose a role to start from.';
export const NAME_REQUIRED = 'Name is required.';
export const NAME_TOO_LONG = `Name is ${NAME_MAX} characters at most.`;
export const DESCRIPTION_TOO_LONG = `Description is ${DESCRIPTION_MAX} characters at most.`;

/** A name as the API keeps it: without the spaces around it, and with white space inside it folded into one space. */
export function cleanRoleName(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** The mistakes of the New role form, by field (`copy_of`, `name`, `description`); an empty record when it is complete. */
export function validateNewRole(v: {
  copy_of: string;
  name: string;
  description?: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (v.copy_of.trim() === '') errors.copy_of = COPY_OF_REQUIRED;
  const name = cleanRoleName(v.name);
  if (name === '') errors.name = NAME_REQUIRED;
  else if (name.length > NAME_MAX) errors.name = NAME_TOO_LONG;
  if ((v.description ?? '').trim().length > DESCRIPTION_MAX)
    errors.description = DESCRIPTION_TOO_LONG;
  return errors;
}

/**
 * The roles to start a new one from: every role, the Owner and the switched-off ones too (a copy takes the ticks and nothing else), in the order the API listed them. For the chooser
 * only: a switched-off role is named "<name> (switched off)" there, and keeps its key; the words of the password step use the roles themselves.
 */
export function startFromChoices(roles: readonly SuperRole[]): SuperRole[] {
  return roles.map((r) => (r.active ? r : { ...r, name: `${r.name} (switched off)` }));
}

// ---- the dialogs of the tab

/** Which dialog is open: the New role form (with the role to start from, or an empty text), or the switch of one role. */
export type RolesDialog = { kind: 'new'; copyOf: string } | { kind: 'switch'; role: SuperRole };

/** The dialog a button of a row opens, or null when it opens none (Edit goes to the screen of the role). */
export function dialogFor(action: RoleAction, role: SuperRole): RolesDialog | null {
  switch (action) {
    case 'copy':
      return { kind: 'new', copyOf: role.key };
    case 'switch':
      return { kind: 'switch', role };
    case 'edit':
      return null;
  }
}
