import React, { useId } from 'react';
import { Check, Link2, Lock } from 'lucide-react';
import type { TickKey } from '@/lib/access';
import type { TickInfo } from '@/lib/api/types';
import { alsoNeedsLine, groupCount, neededByLine } from '../lib/editWords';

// One group of ticks of the Edit role screen (plan: access and roles, Task 25; the pictures are mockups/3-edit-role.png and 5-phone.png): a card with the name of the group and "9 of 17 on",
// and a row for each tick. A row has a box, the tick by its words, and under it, in this order: the help text, "Also needs ..." (its direct needs) and "Needed by ..." (the ticks that are on
// and hold it on).
//   - the whole row is the button: a box and its words toggle together, which is what a thumb needs on a phone. The box is a real check box that is only drawn differently (it is hidden
//     from the eye, and the square beside it is what is seen), so the keyboard and a screen reader get an ordinary check box; the lines under the tick are its description. The hidden
//     check box is `absolute`, so its row is `relative`: otherwise it would sit where the page puts it, outside the scrolling area of the screen, and giving it the focus would scroll
//     the whole page instead of the screen's own area. Its name is the title of the tick (the words and the marks) and nothing under it: the lines under are its description;
//   - a tick that another ticked tick needs is LOCKED: the box is greyed with a lock, it cannot be changed, and "Needed by ..." says why. On the Owner's screen (`readOnly`) every tick is
//     on and locked, and no line about needs is drawn;
//   - a tick that differs from the saved set has the yellow row and the "Changed" mark; a sensitive one has the red "Sensitive" mark;
//   - no tick key is in the markup: ticks are told by their words, and the rows have no key in any attribute.

export function SensitiveTag() {
  return (
    <span className="ml-2 whitespace-nowrap rounded-full border border-[#f9caca] bg-red-50 px-2 py-px align-[1px] text-[11px] font-bold text-red-600">
      Sensitive
    </span>
  );
}

function ChangedTag() {
  return (
    <span className="ml-2 whitespace-nowrap rounded-full bg-[#fdecc0] px-2 py-px align-[1px] text-[11px] font-bold text-[#7a4d00]">
      Changed
    </span>
  );
}

const BOX =
  'mt-px grid h-5 w-5 flex-none place-items-center rounded-[5px] border-[1.5px] peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40';
const BOX_OFF = 'border-[#cdb995] bg-white';
const BOX_ON = 'border-primary bg-primary text-white';
const BOX_LOCKED = 'border-[#d9c9ae] bg-muted text-muted-foreground';
const ROW = 'border-t border-border first:border-t-0';
const CHANGED_ROW = `${ROW} bg-[#fff8e6] shadow-[inset_3px_0_0_var(--accent)]`;
const LINE = 'mt-0.5 text-[12.5px] text-muted-foreground';

function Row({
  tick,
  on,
  changed,
  lockedBy,
  labels,
  readOnly,
  onToggle,
}: {
  tick: TickInfo;
  on: boolean;
  changed: boolean;
  /** The ticks that are on and need this one, when it is locked. */
  lockedBy: readonly TickInfo[] | undefined;
  labels: ReadonlyMap<TickKey, string>;
  readOnly: boolean;
  onToggle: (key: TickKey, on: boolean) => void;
}) {
  const id = useId();
  const needs = readOnly ? null : alsoNeedsLine(tick, labels);
  const neededBy = readOnly || lockedBy === undefined ? null : neededByLine(lockedBy);
  const disabled = readOnly || lockedBy !== undefined;
  const lines = [
    tick.help ? `${id}-help` : null,
    needs !== null ? `${id}-needs` : null,
    neededBy !== null ? `${id}-needed` : null,
  ].filter((line) => line !== null);
  return (
    <li data-testid="tick" className={changed ? CHANGED_ROW : ROW}>
      <label
        className={`relative flex gap-3 px-3.5 py-2.5 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <input
          type="checkbox"
          className="peer sr-only"
          checked={on}
          disabled={disabled}
          aria-labelledby={`${id}-title`}
          aria-describedby={lines.length > 0 ? lines.join(' ') : undefined}
          onChange={(event) => onToggle(tick.key, event.target.checked)}
        />
        <span
          aria-hidden="true"
          className={`${BOX} ${disabled ? BOX_LOCKED : on ? BOX_ON : BOX_OFF}`}
        >
          {disabled ? (
            <Lock size={12} strokeWidth={2.4} />
          ) : on ? (
            <Check size={14} strokeWidth={3} />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span id={`${id}-title`} className="block font-semibold leading-snug text-foreground">
            {tick.label}
            {tick.sensitive && <SensitiveTag />}
            {changed && <ChangedTag />}
          </span>
          {tick.help && (
            <span id={`${id}-help`} className={`block ${LINE}`}>
              {tick.help}
            </span>
          )}
          {needs !== null && (
            <span id={`${id}-needs`} className={`flex items-start gap-1.5 ${LINE}`}>
              <Link2 size={13} aria-hidden="true" className="mt-0.5 flex-none" />
              {needs}
            </span>
          )}
          {neededBy !== null && (
            <span id={`${id}-needed`} className={`flex items-start gap-1.5 ${LINE}`}>
              <Link2 size={13} aria-hidden="true" className="mt-0.5 flex-none" />
              {neededBy}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

interface TickGroupProps {
  name: string;
  /** The ticks of the group, in catalogue order. */
  ticks: readonly TickInfo[];
  /** The ticks that are on now. */
  on: ReadonlySet<TickKey>;
  /** The ticks as they are saved: a tick that differs is marked "Changed". */
  saved: ReadonlySet<TickKey>;
  /** The ticks that cannot be turned off now, each with the ticks that need it. */
  locked: ReadonlyMap<TickKey, TickInfo[]>;
  /** The words of every tick of the catalogue, for the "Also needs" lines. */
  labels: ReadonlyMap<TickKey, string>;
  /** The Owner's screen: every tick is on and locked. */
  readOnly: boolean;
  onToggle: (key: TickKey, on: boolean) => void;
}

export default function TickGroup({
  name,
  ticks,
  on,
  saved,
  locked,
  labels,
  readOnly,
  onToggle,
}: TickGroupProps) {
  const headingId = useId();
  const count = ticks.filter((tick) => on.has(tick.key)).length;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="tick-group"
      className="jewel-card overflow-hidden"
    >
      <h3
        id={headingId}
        className="flex items-center justify-between gap-3 border-b border-border bg-secondary px-3.5 py-2.5 text-xs font-bold uppercase tracking-[0.06em] text-muted-foreground"
      >
        <span>{name}</span>
        <span className="font-semibold normal-case tracking-normal">
          {groupCount(count, ticks.length)}
        </span>
      </h3>
      <ul>
        {ticks.map((tick) => (
          <Row
            key={tick.key}
            tick={tick}
            on={on.has(tick.key)}
            changed={on.has(tick.key) !== saved.has(tick.key)}
            lockedBy={locked.get(tick.key)}
            labels={labels}
            readOnly={readOnly}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}
