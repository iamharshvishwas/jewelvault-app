// The rules of the Edit role screen about ticks (plan: access and roles, Task 25; DESIGN 6.2 "Needs" and 6.5), as plain TypeScript with no React: what turning a tick on or off does, which
// ticks are locked, what differs from the saved set and which of that must be confirmed. tests/unit/tick-edit.test.ts drives this file directly, with the real catalogue.
//   - a tick that needs another turns it on too, and the ticks that one needs, and so on (the screen turns the needed ticks on for her; the API refuses a set that breaks a need);
//   - a tick is turned off only when no other ticked tick needs it: otherwise nothing changes and the very same set comes back (a locked tick has a disabled box on the screen, this is the
//     rule behind it). Those ticks are `lockedTicks`, with the ticks that need them for the "Needed by ..." line;
//   - the sets are never changed: every function gives a new set or an unchanged one, and a key the catalogue does not know (a tick a later release dropped) is ignored, never a crash;
//   - `changesOf` and `sensitiveToConfirm` compare with the SAVED set, so a sensitive tick turned on and off again, or one that was saved as on, asks for nothing.
import { TICK_KEYS, type TickKey } from '@/lib/access';
import type { SuperTicksResponse, TickInfo } from '@/lib/api/types';

/** The tick and everything it needs, through the needs of those, in turn. A key the catalogue does not list is left out (the API would refuse it), and a loop in the needs ends. */
function withNeeds(catalogue: readonly TickInfo[], key: TickKey): TickKey[] {
  const direct = new Map(catalogue.map((tick) => [tick.key, tick.needs] as const));
  const wanted = new Set<TickKey>();
  const walk = (next: TickKey) => {
    const needs = direct.get(next);
    if (needs === undefined || wanted.has(next)) return;
    wanted.add(next);
    for (const need of needs) walk(need);
  };
  walk(key);
  return [...wanted];
}

/**
 * The set after a tick is turned on or off. On: the tick and everything it needs (`withNeeds`). Off: the tick, unless another ticked tick needs it, then nothing changes. When nothing
 * would change, `current` itself is returned.
 */
export function toggleTick(
  catalogue: readonly TickInfo[],
  current: ReadonlySet<TickKey>,
  key: TickKey,
  on: boolean
): ReadonlySet<TickKey> {
  if (!catalogue.some((tick) => tick.key === key)) return current;
  if (on) {
    const wanted = withNeeds(catalogue, key);
    return wanted.every((one) => current.has(one)) ? current : new Set([...current, ...wanted]);
  }
  if (!current.has(key)) return current;
  if (catalogue.some((tick) => tick.needs.includes(key) && current.has(tick.key))) return current;
  const next = new Set(current);
  next.delete(key);
  return next;
}

/** The ticks that are on and cannot be turned off now, each with the ticks that are on and need it, in catalogue order: the "Needed by ..." of the screen. */
export function lockedTicks(
  catalogue: readonly TickInfo[],
  current: ReadonlySet<TickKey>
): Map<TickKey, TickInfo[]> {
  const locked = new Map<TickKey, TickInfo[]>();
  for (const tick of catalogue) {
    if (!current.has(tick.key)) continue;
    for (const need of tick.needs) {
      if (!current.has(need)) continue;
      const needers = locked.get(need);
      if (needers === undefined) locked.set(need, [tick]);
      else needers.push(tick);
    }
  }
  return locked;
}

/** What differs from the saved set: the ticks that are on now and were not, and the ticks that were on and are not, each in catalogue order. */
export function changesOf(
  original: ReadonlySet<TickKey>,
  current: ReadonlySet<TickKey>
): { turnedOn: TickKey[]; turnedOff: TickKey[] } {
  return {
    turnedOn: TICK_KEYS.filter((key) => current.has(key) && !original.has(key)),
    turnedOff: TICK_KEYS.filter((key) => original.has(key) && !current.has(key)),
  };
}

/** Of the ticks that are newly on (`changesOf(...).turnedOn`), the sensitive ones, in catalogue order: the ticks the "I understand" box is about. */
export function sensitiveToConfirm(
  catalogue: readonly TickInfo[],
  turnedOn: readonly TickKey[]
): TickKey[] {
  const newly = new Set(turnedOn);
  return catalogue.filter((tick) => tick.sensitive && newly.has(tick.key)).map((tick) => tick.key);
}

/** A group of the screen with its ticks. */
export interface TickGroupOf {
  name: string;
  ticks: TickInfo[];
}

/**
 * The ticks in the groups of the screen: the groups in the order the catalogue lists them, the ticks of each in catalogue order. A tick whose group is not listed is not lost: its group
 * comes after the listed ones. A group without ticks is left out.
 */
export function groupedTicks(catalogue: SuperTicksResponse): TickGroupOf[] {
  const names = [...new Set([...catalogue.groups, ...catalogue.ticks.map((tick) => tick.group)])];
  return names
    .map((name) => ({ name, ticks: catalogue.ticks.filter((tick) => tick.group === name) }))
    .filter((group) => group.ticks.length > 0);
}
