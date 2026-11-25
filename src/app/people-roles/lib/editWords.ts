// The sentences of the Edit role screen (plan: access and roles, Task 25; DESIGN 6.5; the pictures are mockups/3-edit-role.png and 4-password-confirm.png), as plain TypeScript with no
// React, so that the tests read them without drawing anything: the banner, the lines under a tick, the fixed sentences, and the title, the lines and the button of the password step.
//   - a tick is always told by its words (the `label` of the catalogue), never by its key; a role by its name; nothing here knows a stamp;
//   - the lines under a tick name its DIRECT needs ("Also needs ...") or the ticks that hold it on ("Needed by ..."), each name in curly quotes as the API's own sentences have them.
import type { TickKey } from '@/lib/access';
import type { TickInfo } from '@/lib/api/types';
import type { EditorInfo } from './editorDraft';
import { SCREEN_RELOADS } from './people';
import type { RoleEdit } from './roleEdit';
import { peopleLine } from './roles';
import { changesOf } from './tickEdit';

// ---- the words of the page

export const NAME_LABEL = 'Role name';
export const DESCRIPTION_LABEL = 'What this role is for';
export const SAVED_LINE = 'Saved.';
export const STALE_LINE = 'This role was changed by someone else. Reload it and try again.';
/** Said under the stale line when she pressed Reload and the role could not be read again (Task 24b): her edits stay, and so does the button. */
export const REREAD_FAILED_LINE =
  'Could not read the role again. Check your connection and try Reload again.';
export const OWNER_FIXED_LINE = 'The Owner role is fixed.';
export const LEAVE_QUESTION = 'Leave without saving? Your changes will be lost.';
export const ALSO_NEEDS = 'Also needs';
export const NEEDED_BY = 'Needed by';
export const UNDERSTAND_TEXT = 'I understand: people with this role will be able to:';
export const UNDERSTAND_FIRST = 'Tick “I understand” first.';
export const PASSWORD_HINT = 'Asks for your password';
export const roleEditConfirmLabel = 'Confirm and save';

/** Who has the role: "3 people have this role:" when their names follow, "3 people have this role." when not, and "Nobody has this role yet." for none. */
export function holdersLine(people: number, namesFollow: boolean): string {
  if (people === 0) return 'Nobody has this role yet.';
  return `${peopleLine(people)} ${people === 1 ? 'has' : 'have'} this role${namesFollow ? ':' : '.'}`;
}

/** "1 change not saved yet", "3 changes not saved yet". */
export function bannerWords(count: number): string {
  return count === 1 ? '1 change not saved yet' : `${count} changes not saved yet`;
}

/** What the banner says changed: the name, the description, then the ticks in catalogue order, each by its words. */
export function changedWords(info: EditorInfo, catalogue: readonly TickInfo[]): string[] {
  const changed = new Set([...info.changes.turnedOn, ...info.changes.turnedOff]);
  return [
    ...(info.nameChanged ? [NAME_LABEL] : []),
    ...(info.descriptionChanged ? [DESCRIPTION_LABEL] : []),
    ...catalogue.filter((tick) => changed.has(tick.key)).map((tick) => tick.label),
  ];
}

/** Names told in a sentence, each in curly quotes: “A”, “A” and “B”, “A”, “B” and “C”. */
export function namesInWords(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  return quoted.length < 2
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** "Also needs “A” and “B”": the direct needs of a tick by their words, or null when it needs nothing. A need the catalogue has no words for is left out (a key is never shown). */
export function alsoNeedsLine(tick: TickInfo, labels: ReadonlyMap<TickKey, string>): string | null {
  const names = tick.needs.flatMap((need) => labels.get(need) ?? []);
  return names.length === 0 ? null : `${ALSO_NEEDS} ${namesInWords(names)}`;
}

/** "Needed by “A”": the ticks that are on and need a locked tick. */
export function neededByLine(needers: readonly TickInfo[]): string {
  return `${NEEDED_BY} ${namesInWords(needers.map((tick) => tick.label))}`;
}

/** "9 of 17 on". */
export function groupCount(on: number, total: number): string {
  return `${on} of ${total} on`;
}

// ---- the password step

export function roleEditTitle(edit: RoleEdit): string {
  return `Save changes to “${edit.role.name}”?`;
}

/**
 * Who has the role, that a change of ticks works at once, and what that does to their screen: it reloads, and what they had not saved is lost (`SCREEN_RELOADS`, final review of the
 * website, Important I1). A change of the name or the description does not change what anybody may do, so it says none of that.
 */
export function roleEditIntro(edit: RoleEdit): string {
  const people = edit.role.people;
  if (people === 0) return 'Nobody has this role yet.';
  const who = `${peopleLine(people)} ${people === 1 ? 'has' : 'have'} this role.`;
  return edit.ticks === undefined
    ? who
    : `${who} The change works on their very next click. ${SCREEN_RELOADS}`;
}

/** One part of what is about to be saved: a list of ticks that are turned on or off, or one line about the name or the description. */
export type SummaryPart =
  | {
      kind: 'ticks';
      heading: 'Turning on' | 'Turning off';
      ticks: Array<{ label: string; sensitive: boolean }>;
    }
  | { kind: 'line'; text: string };

/**
 * What is about to be saved, in words: when the ticks change, "Turning on" and "Turning off" with the ticks by their words in catalogue order (an empty list is drawn as "Nothing"); then
 * "New name: ..." and "Description changed" when those changed.
 */
export function roleEditSummary(edit: RoleEdit, catalogue: readonly TickInfo[]): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if (edit.ticks !== undefined) {
    const { turnedOn, turnedOff } = changesOf(new Set(edit.role.ticks), new Set(edit.ticks));
    const listed = (keys: readonly TickKey[]) =>
      catalogue
        .filter((tick) => keys.includes(tick.key))
        .map((tick) => ({ label: tick.label, sensitive: tick.sensitive }));
    parts.push(
      { kind: 'ticks', heading: 'Turning on', ticks: listed(turnedOn) },
      { kind: 'ticks', heading: 'Turning off', ticks: listed(turnedOff) }
    );
  }
  if (edit.name !== undefined) parts.push({ kind: 'line', text: `New name: ${edit.name}` });
  if (edit.description !== undefined) parts.push({ kind: 'line', text: 'Description changed' });
  return parts;
}
