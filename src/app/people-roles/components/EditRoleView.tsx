'use client';
import React, { useRef } from 'react';
import { ChevronLeft, CircleAlert } from 'lucide-react';
import type { TickKey } from '@/lib/access';
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import type { Draft, EditorInfo, Notice } from '../lib/editorDraft';
import {
  DESCRIPTION_LABEL,
  NAME_LABEL,
  OWNER_FIXED_LINE,
  bannerWords,
  changedWords,
} from '../lib/editWords';
import type { SuperTicks } from '../lib/superStore';
import { groupedTicks, lockedTicks } from '../lib/tickEdit';
import { goToBox } from '../lib/understandHint';
import { Holders, LeavePrompt, Notices, Understand } from './EditRoleParts';
import { TextAreaField, TextField } from './FormFields';
import SaveBar from './SaveBar';
import TickGroup from './TickGroup';

// The Edit role screen as it is drawn (plan: access and roles, Task 25; DESIGN 6.5; the pictures are mockups/3-edit-role.png and 5-phone.png): "Back to roles", the heading with Cancel and
// Save changes, the name and what the role is for, who has it, the banner "n changes not saved yet", the box "I understand", and the ticks in their six groups. `EditRole` gives it the
// draft and what to do on each press; nothing here keeps state.
//   - a page, not a dialog: the dialogs of People & Roles are on top of it (`ConfirmPasswordDialog`, drawn by `EditRole` when Save was pressed). While that one is up (`frozen`) every control
//     of the page is off (one disabled `fieldset`): nothing traps the keyboard behind an overlay, and what is being saved must not change under it;
//   - Cancel and "Back to roles" leave; with edits not saved they ask first, with one plain line ("Leave without saving? ...") under the top, where "Back to roles" is, also when the
//     press was on the Cancel of the bar at the bottom of a phone (the line scrolls into view);
//   - the Owner role is fixed: it is shown as plain text with every tick on and locked, and has no Save;
//   - on a tablet and a desktop Cancel and Save are in the heading; below `md` they are in a bar that sticks to the bottom of the page, just above the phone menu, which is fixed to the
//     bottom of the screen and about 69 px (4.3rem) high, hence the offset;
//   - the ticks are two columns from `xl` (1280 px) in the order of the catalogue, one column below; no tick key, role key, id or stamp is in the markup;
//   - the box "I understand" is where the hint under Save leads (final review of the website, M5): the page holds a ref to its check box and gives both bars the one handler that goes to it.

/** What each press of the page does. */
export interface EditorActions {
  name: (value: string) => void;
  description: (value: string) => void;
  toggle: (key: TickKey, on: boolean) => void;
  understood: (on: boolean) => void;
  save: () => void;
  /** Cancel and "Back to roles": leave, or ask first when there are edits. */
  leave: () => void;
  leaveForGood: () => void;
  keepEditing: () => void;
  reload: () => void;
}

export interface EditRoleViewProps {
  catalogue: SuperTicks;
  /** The role as the screen holds it now: whether it is on, who has it, whether it is fixed. */
  role: SuperRole;
  people: readonly SuperPerson[];
  draft: Draft;
  info: EditorInfo;
  notice: Notice | null;
  /** The question "Leave without saving?" is asked. */
  leaving: boolean;
  /** The password step is open: the page behind it is off. */
  frozen: boolean;
  on: EditorActions;
}

export default function EditRoleView({
  catalogue,
  role,
  people,
  draft,
  info,
  notice,
  leaving,
  frozen,
  on,
}: EditRoleViewProps) {
  const fixed = role.fixed;
  const labels = new Map(catalogue.ticks.map((tick) => [tick.key, tick.label] as const));
  const everything: ReadonlySet<TickKey> = new Set(catalogue.ticks.map((tick) => tick.key));
  const shownOn = fixed ? everything : draft.ticks;
  const locked = fixed ? new Map() : lockedTicks(catalogue.ticks, draft.ticks);
  const needsBox = info.confirm.length > 0 && !info.understood;
  // the check box of the box "I understand": what the hint under Save takes her to (on a phone the box is at the top and the bar at the bottom)
  const understandBox = useRef<HTMLInputElement>(null);
  const showBox = () => goToBox(understandBox.current);
  const bar = {
    canSave: info.canSave,
    needsBox,
    onCancel: on.leave,
    onSave: on.save,
    onShowBox: showBox,
  };
  return (
    <fieldset
      data-testid="edit-role"
      disabled={frozen}
      className="m-0 min-w-0 space-y-4 border-0 p-0"
    >
      <div>
        <button
          type="button"
          data-testid="edit-role-back"
          onClick={on.leave}
          className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Back to roles
        </button>
      </div>

      {leaving && info.dirty && <LeavePrompt onLeave={on.leaveForGood} onKeep={on.keepEditing} />}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-xl font-bold text-foreground md:text-2xl">
              {fixed ? role.name : 'Edit role'}
            </h2>
            {!role.active && (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-gray-400" />
                Switched off
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {fixed ? OWNER_FIXED_LINE : 'Tick what people with this role can do and see.'}
          </p>
        </div>
        {!fixed && (
          <div className="hidden md:block">
            <SaveBar testId="edit-role-head" {...bar} />
          </div>
        )}
      </div>

      <Notices notice={notice} onReload={on.reload} />

      <section className="jewel-card space-y-3 p-4">
        {fixed ? (
          <dl className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                {NAME_LABEL}
              </dt>
              <dd className="mt-1.5 text-sm text-foreground">{role.name}</dd>
            </div>
            {role.description !== '' && (
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {DESCRIPTION_LABEL}
                </dt>
                <dd className="mt-1.5 text-sm text-foreground">{role.description}</dd>
              </div>
            )}
          </dl>
        ) : (
          <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
            <TextField
              look="page"
              label={NAME_LABEL}
              testId="edit-role-name"
              capitalize="words"
              value={draft.name}
              onChange={on.name}
              error={info.errors.name}
              maxLength={40}
              required
            />
            <TextAreaField
              look="page"
              label={DESCRIPTION_LABEL}
              testId="edit-role-description"
              value={draft.description}
              onChange={on.description}
              error={info.errors.description}
              maxLength={200}
              required={false}
            />
          </div>
        )}
        <Holders role={role} people={people} />
      </section>

      {!fixed && info.count > 0 && (
        <p
          role="status"
          data-testid="edit-role-banner"
          className="flex items-start gap-2 rounded-lg border border-[#f1d28a] bg-amber-50 px-3.5 py-2.5 text-sm text-[#7a4d00]"
        >
          <CircleAlert size={18} aria-hidden="true" className="mt-px flex-none" />
          <span>
            <b>{bannerWords(info.count)}:</b> {changedWords(info, catalogue.ticks).join(', ')}
          </span>
        </p>
      )}

      {!fixed && info.confirm.length > 0 && (
        <Understand
          boxRef={understandBox}
          labels={info.confirm.flatMap((key) => labels.get(key) ?? [])}
          checked={info.understood}
          onChange={on.understood}
        />
      )}

      <div data-testid="tick-groups" className="xl:columns-2 xl:gap-3.5">
        {groupedTicks(catalogue).map((group) => (
          <div key={group.name} className="mb-3.5 break-inside-avoid">
            <TickGroup
              name={group.name}
              ticks={group.ticks}
              on={shownOn}
              saved={fixed ? everything : draft.saved}
              locked={locked}
              labels={labels}
              readOnly={fixed}
              onToggle={on.toggle}
            />
          </div>
        ))}
      </div>

      {!fixed && (
        <div
          data-testid="edit-role-phone-bar"
          className="sticky bottom-[4.3rem] z-10 -mx-4 border-t border-border bg-card px-4 pb-3.5 pt-2.5 md:hidden"
        >
          <SaveBar testId="edit-role-phone" {...bar} />
        </div>
      )}
    </fieldset>
  );
}
