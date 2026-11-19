'use client';
import React, { useEffect, useId, useRef } from 'react';
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import type { Notice } from '../lib/editorDraft';
import {
  LEAVE_QUESTION,
  REREAD_FAILED_LINE,
  SAVED_LINE,
  STALE_LINE,
  UNDERSTAND_TEXT,
  holdersLine,
} from '../lib/editWords';

// The small parts of the Edit role screen that are not the ticks (plan: access and roles, Task 25; the pictures are mockups/3-edit-role.png and 5-phone.png), drawn by `EditRoleView`:
// the question "Leave without saving?", the line under the heading ("Saved.", or why it was not), who has the role, and the box "I understand" of the sensitive ticks.
//   - the question is one plain line with two buttons, not a dialog; it is an alert so that it is read out when it appears, and it scrolls into view: it is asked from the Cancel of the bar
//     at the bottom of a phone as well, and the line is at the top;
//   - a role changed by someone else and any other refusal are alerts; the first has "Reload" (the edits stay on screen until she presses it), the second says the API's own sentence. When
//     the name or the description of the same save is already live, the alert of the first says so before its sentence ("The name was saved, but the ticks were not."): Reload would
//     drop her ticks, and she must know the rename stuck. When she pressed Reload and the role could not be read again, the same alert says so after its sentence (Task 24b) and keeps
//     its button, so that she can press it again;
//   - the box is ticked for the sensitive ticks that are newly on, which it lists by their words; it is tied to the list for a screen reader.

export function LeavePrompt({ onLeave, onKeep }: { onLeave: () => void; onKeep: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  // asked from the Cancel of the bar at the bottom of a phone, the line is at the top: show it
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div
      ref={box}
      role="alert"
      data-testid="edit-role-leave"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-[#f1d28a] bg-amber-50 px-3.5 py-2.5 text-sm text-[#7a4d00]"
    >
      <p className="font-semibold">{LEAVE_QUESTION}</p>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="edit-role-leave-yes"
          onClick={onLeave}
          className="btn-secondary py-2 text-xs"
        >
          Leave
        </button>
        <button
          type="button"
          data-testid="edit-role-keep"
          onClick={onKeep}
          className="btn-primary py-2 text-xs"
        >
          Keep editing
        </button>
      </div>
    </div>
  );
}

export function Notices({ notice, onReload }: { notice: Notice | null; onReload: () => void }) {
  if (notice === null) return null;
  if (notice.kind === 'saved')
    return (
      <p
        role="status"
        data-testid="edit-role-saved"
        className="rounded-lg border border-green-200 bg-green-50 px-3.5 py-2 text-sm font-semibold text-green-700"
      >
        {SAVED_LINE}
      </p>
    );
  return (
    <div
      role="alert"
      data-testid={notice.kind === 'stale' ? 'edit-role-stale' : 'edit-role-problem'}
      className="jewel-card flex flex-wrap items-center gap-3 border-red-200 bg-red-50 p-3"
    >
      <div className="space-y-1 text-sm font-semibold text-red-700">
        {notice.kind === 'stale' && notice.savedLine !== null && <p>{notice.savedLine}</p>}
        <p>{notice.kind === 'stale' ? STALE_LINE : notice.text}</p>
        {notice.kind === 'stale' && notice.readFailed === true && <p>{REREAD_FAILED_LINE}</p>}
      </div>
      {notice.kind === 'stale' && (
        <button
          type="button"
          data-testid="edit-role-reload"
          onClick={onReload}
          className="btn-secondary py-2 text-xs"
        >
          Reload
        </button>
      )}
    </div>
  );
}

export function Holders({ role, people }: { role: SuperRole; people: readonly SuperPerson[] }) {
  const names = people.filter((person) => person.role === role.key && person.active);
  return (
    <div
      data-testid="edit-role-people"
      className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
    >
      <span>{holdersLine(role.people, role.people > 0 && names.length > 0)}</span>
      {role.people > 0 &&
        names.map((person) => (
          <span
            key={person.id}
            className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-foreground"
          >
            {person.full_name}
          </span>
        ))}
    </div>
  );
}

export function Understand({
  labels,
  checked,
  onChange,
}: {
  labels: readonly string[];
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div
      data-testid="edit-role-understand"
      className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-[13px] text-red-900"
    >
      <input
        id={`${id}-box`}
        type="checkbox"
        data-testid="edit-role-understand-box"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={`${id}-list`}
        className="mt-0.5 h-4 w-4 flex-none accent-red-700"
      />
      <div className="min-w-0">
        <label htmlFor={`${id}-box`} className="cursor-pointer">
          <b>Sensitive.</b> {UNDERSTAND_TEXT}
        </label>
        <ul id={`${id}-list`} className="mt-1 list-disc space-y-0.5 pl-5">
          {labels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
