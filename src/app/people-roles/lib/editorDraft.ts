// What the person has changed so far on the Edit role screen (plan: access and roles, Task 25; DESIGN 6.5), as plain TypeScript with no React: the draft, how it changes, what it adds up to
// (the count of the banner, the mistakes, the sensitive ticks to confirm, whether Save works) and what a save would write. tests/unit/people-roles-editor.test.ts drives this file directly.
//   - the draft keeps the saved copy it was made from (`base`): "changed" is measured against it, and a save names its `updated_at`. It is NOT the list the screen holds now: a list read again
//     (after a write, or "Try again") must not give a draft with edits a newer copy to be saved over, since that would undo what somebody else did without a word. The copy changes only
//     when she saves (the answer of the API is the new copy: `seed`), when she asks to reload (`seed` from the list as it is then), and when the first write of a save went through and
//     the second did not (`rebase`);
//   - the box "I understand" is ticked for the exact set of sensitive ticks that were newly on when she ticked it (`understood`): turn on another one and the box is empty again;
//   - the name is compared as the API keeps it (spaces around it gone, white space inside folded), the description trimmed; capitals are a rename.
import type { TickKey } from '@/lib/access';
import type { SuperRole, TickInfo } from '@/lib/api/types';
import type { RoleEdit, RoleEditOutcome } from './roleEdit';
import { cleanRoleName, validateRoleText } from './roles';
import { changesOf, sensitiveToConfirm, toggleTick } from './tickEdit';

export interface Draft {
  /** The saved copy the draft was made from. */
  base: SuperRole;
  /** The ticks of `base`, as a set (made once). */
  saved: ReadonlySet<TickKey>;
  name: string;
  description: string;
  /** The ticks as they are now. */
  ticks: ReadonlySet<TickKey>;
  /** The sensitive ticks (their keys, joined) the box "I understand" was ticked for; an empty text when it is not ticked. */
  understood: string;
}

/** A draft with nothing changed: the saved role as it is. */
export function seedOf(role: SuperRole): Draft {
  return {
    base: role,
    saved: new Set(role.ticks),
    name: role.name,
    description: role.description,
    ticks: new Set(role.ticks),
    understood: '',
  };
}

export type DraftAction =
  | { type: 'name'; value: string }
  | { type: 'description'; value: string }
  | { type: 'tick'; catalogue: readonly TickInfo[]; key: TickKey; on: boolean }
  /** The box: `confirm` are the sensitive ticks it is about. */
  | { type: 'understood'; confirm: readonly TickKey[]; on: boolean }
  /** Start again from this saved role: the edits are gone. */
  | { type: 'seed'; role: SuperRole }
  /** This saved role replaces the copy the draft is based on: its name and description are the draft's now, the ticks that were ticked stay (the first write of a save went through). */
  | { type: 'rebase'; role: SuperRole };

export function draftReducer(state: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case 'name':
      return { ...state, name: action.value };
    case 'description':
      return { ...state, description: action.value };
    case 'tick':
      return { ...state, ticks: toggleTick(action.catalogue, state.ticks, action.key, action.on) };
    case 'understood':
      return { ...state, understood: action.on ? action.confirm.join(',') : '' };
    case 'seed':
      return seedOf(action.role);
    case 'rebase':
      return {
        ...state,
        base: action.role,
        saved: new Set(action.role.ticks),
        name: action.role.name,
        description: action.role.description,
      };
  }
}

/** What differs from the saved copy, and how many things that is: the changed ticks, plus one for the name and one for the description. */
function changedOf(draft: Draft) {
  const nameChanged = cleanRoleName(draft.name) !== cleanRoleName(draft.base.name);
  const descriptionChanged = draft.description.trim() !== draft.base.description.trim();
  const changes = changesOf(draft.saved, draft.ticks);
  const count =
    changes.turnedOn.length +
    changes.turnedOff.length +
    (nameChanged ? 1 : 0) +
    (descriptionChanged ? 1 : 0);
  return { nameChanged, descriptionChanged, changes, count };
}

export interface EditorInfo {
  nameChanged: boolean;
  descriptionChanged: boolean;
  changes: { turnedOn: TickKey[]; turnedOff: TickKey[] };
  /** How many things differ from the saved copy: the changed ticks, plus one for the name and one for the description. */
  count: number;
  /** The mistakes of the name and the description, by field. */
  errors: Record<string, string>;
  /** The sensitive ticks that are newly on: the box is about these. */
  confirm: TickKey[];
  /** Whether the box is ticked for exactly those. */
  understood: boolean;
  /** Anything is not saved yet. */
  dirty: boolean;
  /** Save works: something changed, the texts are fine, and the box (when there is one) is ticked. */
  canSave: boolean;
}

/** What the draft adds up to. `roles` are the roles the screen holds: a name one of the OTHER roles has is a mistake. */
export function infoOf(
  draft: Draft,
  catalogue: readonly TickInfo[],
  roles: readonly SuperRole[]
): EditorInfo {
  const { nameChanged, descriptionChanged, changes, count } = changedOf(draft);
  const errors = validateRoleText(
    { name: draft.name, description: draft.description },
    roles.filter((role) => role.key !== draft.base.key)
  );
  const confirm = sensitiveToConfirm(catalogue, changes.turnedOn);
  const understood = confirm.length > 0 && draft.understood === confirm.join(',');
  return {
    nameChanged,
    descriptionChanged,
    changes,
    count,
    errors,
    confirm,
    understood,
    dirty: count > 0,
    canSave: count > 0 && Object.keys(errors).length === 0 && (confirm.length === 0 || understood),
  };
}

/** A line under the heading of the screen: that it was saved, or why it was not. */
export type Notice = { kind: 'saved' } | { kind: 'stale' } | { kind: 'problem'; text: string };

/** What the screen does with the outcome of a save. */
export interface Settled {
  /** What happens to the draft, or null when it stays as it is. */
  action: DraftAction | null;
  /** The line under the heading, or null for none. */
  notice: Notice | null;
  /** The sentence the password step shows, and then stays open (the password was refused); null when the step closes. */
  stepError: string | null;
}

/**
 * What the screen does with the outcome of a save (`runRoleEdit`). Saved: the draft starts again from the role the API answered with, and the line says "Saved.". A password that was
 * refused stays on the password step with its sentence. Anything else closes the step: a role changed by someone else keeps her edits and says so, any other refusal says the API's
 * own sentence; and when the first write of a save went through (`saved`) the draft takes that role as its saved copy, with the ticks she ticked still ticked.
 */
export function settle(outcome: RoleEditOutcome): Settled {
  switch (outcome.kind) {
    case 'password':
      return { action: null, notice: null, stepError: outcome.error };
    case 'saved':
      return {
        action: { type: 'seed', role: outcome.role },
        notice: { kind: 'saved' },
        stepError: null,
      };
    case 'stale':
    case 'refused':
      return {
        action: outcome.saved === null ? null : { type: 'rebase', role: outcome.saved },
        notice:
          outcome.kind === 'stale' ? { kind: 'stale' } : { kind: 'problem', text: outcome.error },
        stepError: null,
      };
  }
}

/**
 * What Save writes, or null when Save does not work (nothing changed, the name or the description is not fine, the box "I understand" is not ticked). The button is off then; this is the
 * second lock on the same door, for what writes the access of the shop.
 */
export function saveOf(
  draft: Draft,
  catalogue: readonly TickInfo[],
  roles: readonly SuperRole[]
): RoleEdit | null {
  return infoOf(draft, catalogue, roles).canSave ? roleEditOf(draft, catalogue) : null;
}

/** What a save would write: only what changed. The ticks are the whole set as a list in catalogue order (a key the catalogue does not know is not sent). */
export function roleEditOf(draft: Draft, catalogue: readonly TickInfo[]): RoleEdit {
  const { nameChanged, descriptionChanged, changes } = changedOf(draft);
  const ticksChanged = changes.turnedOn.length + changes.turnedOff.length > 0;
  return {
    role: draft.base,
    ...(nameChanged ? { name: cleanRoleName(draft.name) } : {}),
    ...(descriptionChanged ? { description: draft.description.trim() } : {}),
    ...(ticksChanged
      ? { ticks: catalogue.map((tick) => tick.key).filter((key) => draft.ticks.has(key)) }
      : {}),
  };
}
