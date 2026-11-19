'use client';
import React, { useState } from 'react';
import { canAccessPath } from '@/lib/access';
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import { useHolder } from '@/lib/useAccess';
import type { SuperTicks } from '../lib/superStore';
import { useSuper, type SuperView } from '../lib/useSuper';
import PeopleTab from './PeopleTab';
import RolesTab from './RolesTab';

// People & Roles (plan: access and roles, Tasks 22 to 25; DESIGN 6.5; the pictures are mockups/1-people.png to 5-phone.png): the Super Admin's own screen, where she runs the logins
// and the roles of the shop. This is the shell: the heading, the two tabs (People first; component state, no address of their own) and what the screen says while it loads or when
// a read failed. The bodies of the tabs are given what has been loaded as props, and call `reload` after each write: the People tab is Task 23 (`PeopleTab`), the Roles tab is
// Task 24 (`RolesTab`; its Edit button is wired to the editor by Task 25). The route gate (AppLayout) opens the screen for the Super Admin alone (`superAdmin` in SCREENS of
// src/lib/access.ts); the check here keeps the screen from reading anything for a person it is not for.
//   - only one tab body is drawn, so changing tabs unmounts the other one and what it held is gone. A body that holds something that must not be lost (a dialog is open: a temporary
//     password that is shown once, a form that was filled; or, for the editor, edits that are not saved) says so with `onBusy`, and the shell locks the tab strip meanwhile: the tab
//     buttons are disabled and a press on one leads nowhere (`nextTab`). Nothing traps the keyboard behind an overlay, so a press with the keyboard is possible and must not do harm.

export type PeopleRolesTab = 'people' | 'roles';

const TABS: ReadonlyArray<{ id: PeopleRolesTab; label: string }> = [
  { id: 'people', label: 'People' },
  { id: 'roles', label: 'Roles' },
];

/** What a tab body is given once everything has loaded. */
export interface TabBodyProps {
  ticks: SuperTicks;
  people: SuperPerson[];
  roles: SuperRole[];
  /** Reads the people and the roles again: called after every write. */
  reload: () => Promise<void>;
  /**
   * Tells the shell whether the body is busy: it holds something that a change of tab would lose. A body calls it with `true` while it has a dialog open (or unsaved edits), with
   * `false` otherwise, and with `false` when it goes away.
   */
  onBusy: (busy: boolean) => void;
}

/** Which tab a press on a tab button leads to: the one asked for, unless a body is busy, then the one the screen is on. */
export function nextTab(
  current: PeopleRolesTab,
  requested: PeopleRolesTab,
  busy: boolean
): PeopleRolesTab {
  return busy ? current : requested;
}

// TODO(task-25): open the editor
const openEditor = () => undefined;

const ignore = () => undefined;

/** The screen as the store holds it now (drawn from the view it is given: the container below gives it the store's). `busy` is what the bodies last said with `onBusy`. */
export function PeopleRolesView({
  view,
  tab,
  onTab,
  busy = false,
  onBusy = ignore,
}: {
  view: SuperView;
  tab: PeopleRolesTab;
  onTab: (tab: PeopleRolesTab) => void;
  busy?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const { status, error, ticks, people, roles, reload } = view;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">People & Roles</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Who can sign in, and what each role lets them do.
        </p>
      </div>

      {status === 'loading' && (
        <p
          role="status"
          data-testid="people-roles-loading"
          className="text-sm text-muted-foreground"
        >
          Loading People & Roles...
        </p>
      )}

      {error !== null && (
        <div
          role="alert"
          data-testid="people-roles-error"
          className="jewel-card p-3 bg-red-50 border-red-200 flex flex-wrap items-center gap-3"
        >
          <p className="text-sm font-semibold text-red-700">{error}</p>
          <button
            type="button"
            data-testid="people-roles-retry"
            onClick={() => void reload()}
            className="btn-secondary py-2 text-xs"
          >
            Try again
          </button>
        </div>
      )}

      {ticks !== null && (
        <div>
          <div
            role="tablist"
            aria-label="People and roles"
            className="flex border-b border-border overflow-x-auto scrollbar-thin"
          >
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`people-roles-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="people-roles-panel"
                disabled={busy}
                aria-disabled={busy ? true : undefined}
                onClick={() => onTab(id)}
                className={`px-4 py-3 text-sm transition-colors whitespace-nowrap disabled:cursor-not-allowed ${
                  tab === id ? 'tab-active' : busy ? 'tab-inactive opacity-50' : 'tab-inactive'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="people-roles-panel"
            aria-labelledby={`people-roles-tab-${tab}`}
            className="pt-4"
          >
            {tab === 'people' ? (
              <PeopleTab
                ticks={ticks}
                people={people}
                roles={roles}
                reload={reload}
                onBusy={onBusy}
              />
            ) : (
              <RolesTab
                ticks={ticks}
                people={people}
                roles={roles}
                reload={reload}
                onBusy={onBusy}
                onEdit={openEditor}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PeopleRolesScreen() {
  const view = useSuper();
  const [tab, setTab] = useState<PeopleRolesTab>('people');
  const [busy, setBusy] = useState(false);
  return (
    <PeopleRolesView
      view={view}
      tab={tab}
      onTab={(requested) => setTab((current) => nextTab(current, requested, busy))}
      busy={busy}
      onBusy={setBusy}
    />
  );
}

export default function PeopleRolesClient() {
  const holder = useHolder();
  if (!canAccessPath(holder, '/people-roles')) return null;
  return <PeopleRolesScreen />;
}
