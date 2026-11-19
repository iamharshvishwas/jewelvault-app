// The rules of the People tab (plan: access and roles, Task 23; DESIGN 6.5 and 6.6; rulings R11 and R12), as plain TypeScript with no React: which buttons a row has, the words of a row,
// and what the add, edit and change-role forms check before they go on to the password step. tests/unit/people-roles-people.test.ts drives this file directly.
//   - a Super Admin login is managed in the terminal (R12): her own row has Edit only (her name and e-mail, DESIGN guardrail 2), any other Super Admin row has no button;
//   - everybody else has the four buttons, and the last one switches the person off or on by `active`. A switched-off person keeps Change role: the API refuses to switch a person on
//     while the role is switched off, and its sentence says "Change the role first";
//   - the checks here are the ones the API makes (src/admin/routes.ts of the API: a name of 1 to 120 characters, an e-mail of the shape `x@y.z` with no spaces, 254 at most, kept in lower
//     case), so that a mistake is shown on the form and not after the password was typed. The API's own refusal is still shown as it comes.
import type { SuperPerson, SuperRole } from '@/lib/api/types';

export type PersonAction = 'edit' | 'role' | 'reset' | 'switch';

/** The buttons of a row, in the order they are drawn. */
export function personActions(p: SuperPerson, meId: string): PersonAction[] {
  if (p.is_super_admin) return p.id === meId ? ['edit'] : [];
  return ['edit', 'role', 'reset', 'switch'];
}

export function statusLabel(p: SuperPerson): 'Active' | 'Switched off' {
  return p.active ? 'Active' : 'Switched off';
}

/** The words of a button: the same as the picture (mockups/1-people.png). */
export function actionLabel(action: PersonAction, p: SuperPerson): string {
  switch (action) {
    case 'edit':
      return 'Edit';
    case 'role':
      return 'Change role';
    case 'reset':
      return 'Reset password';
    case 'switch':
      return p.active ? 'Switch off' : 'Switch on';
  }
}

/** Why a Super Admin row has no (or few) buttons, or null for everybody else. The first sentence is the picture's. */
export function lockLine(p: SuperPerson, meId: string): string | null {
  if (!p.is_super_admin) return null;
  return p.id === meId
    ? 'This is you. Only your name and e-mail can be changed here.'
    : 'This login cannot be changed here.';
}

/** "Signed out of 2 devices." after a reset; nothing for none, and nothing when the answer did not give a count. */
export function sessionsEndedLine(count: unknown): string | null {
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return null;
  return count === 1 ? 'Signed out of 1 device.' : `Signed out of ${count} devices.`;
}

// ---- the forms

export interface NewPersonValues {
  full_name: string;
  email: string;
  role: string;
}
export interface EditValues {
  full_name: string;
  email: string;
}
/** What an edit changes: only the fields that differ from the person as listed. */
export interface PersonEdits {
  full_name?: string;
  email?: string;
}

const NAME_MAX = 120;
const EMAIL_MAX = 254;
// the shape of the API's own check (an e-mail has no spaces, one @, and a dot after it)
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const NAME_REQUIRED = 'Name is required.';
export const NAME_TOO_LONG = `Name is ${NAME_MAX} characters at most.`;
export const EMAIL_INVALID = 'Enter an e-mail address such as name@example.com.';
export const ROLE_REQUIRED = 'Choose a role.';
export const SAME_ROLE = 'This person already has that role. Choose a different one.';
export const NOTHING_CHANGED_YET = 'Nothing has been changed yet.';
/** What a taken e-mail says. It is the API's `email is already used by another user`, said as the rest of the screen speaks (final review of the website, Ruling AB (c)): the form cannot catch it, the database compares e-mails by its own collation. */
export const EMAIL_TAKEN = 'Another person already has this e-mail.';
/**
 * What the screen of a person says when their access changes: ANY change of access (a new role for the person, a tick turned on or off for their role, even a tick turned ON) empties what
 * their screen holds and draws it again within one poll (8 seconds, 30 on a hidden tab), so a bill that is half made or a form that is half filled is gone, with no message (final review of the
 * website, Important I1, Ruling AB (d)). The two steps that change access say it: the Change role step and the password step of a role whose ticks change.
 */
export const SCREEN_RELOADS = 'Their screen reloads at once: anything they have not saved is lost.';
/** What a role that is not active says: the API's `role is not an active role`, for a role that another browser switched off since the form was opened. */
export const ROLE_SWITCHED_OFF = 'That role is switched off. Choose another role.';

/** An e-mail as the API keeps it: without the spaces around it, in lower case. */
export function normalizeEmail(text: string): string {
  return text.trim().toLowerCase();
}

function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return NAME_REQUIRED;
  return trimmed.length > NAME_MAX ? NAME_TOO_LONG : null;
}

function emailProblem(email: string): string | null {
  const trimmed = email.trim();
  return trimmed.length <= EMAIL_MAX && EMAIL_SHAPE.test(trimmed) ? null : EMAIL_INVALID;
}

/** The mistakes of the Add form, by field (`full_name`, `email`, `role`); an empty record when it is complete. */
export function validateNewPerson(v: NewPersonValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = nameProblem(v.full_name);
  if (name !== null) errors.full_name = name;
  const email = emailProblem(v.email);
  if (email !== null) errors.email = email;
  if (v.role.trim() === '') errors.role = ROLE_REQUIRED;
  return errors;
}

/** The mistakes of the Edit form, by field. Whether anything was changed at all is `editChanges`. */
export function validateEditPerson(v: EditValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = nameProblem(v.full_name);
  if (name !== null) errors.full_name = name;
  const email = emailProblem(v.email);
  if (email !== null) errors.email = email;
  return errors;
}

/** The fields of the Edit form that differ from the person as listed; an empty record when nothing was changed. The e-mail in other letters is the same e-mail. */
export function editChanges(p: SuperPerson, v: EditValues): PersonEdits {
  const changes: PersonEdits = {};
  const name = v.full_name.trim();
  if (name !== p.full_name) changes.full_name = name;
  const email = normalizeEmail(v.email);
  if (email !== normalizeEmail(p.email)) changes.email = email;
  return changes;
}

/** The mistakes of the Change role form: a role must be chosen, and it must be another one. */
export function validateRoleChoice(p: SuperPerson, role: string): Record<string, string> {
  if (role === '') return { role: ROLE_REQUIRED };
  if (role === p.role) return { role: SAME_ROLE };
  return {};
}

/** The roles a person can be given: the active ones, the Owner too (the Super Admin may give it), in the order the API listed them. */
export function activeRoleChoices(roles: SuperRole[]): SuperRole[] {
  return roles.filter((r) => r.active);
}
