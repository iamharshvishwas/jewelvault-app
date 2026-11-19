// The store behind the People & Roles screen (plan: access and roles, Task 22): what the screen loads when it opens, what it reads again after a write, and what stays on screen when a
// read fails. Plain TypeScript with no React, like `createAuditFeed` (src/lib/activityLog.ts): the hook `useSuper` hands it to the components and the unit tests drive it with a stub.
//   - opening reads the ticks, the people and the roles, once. The ticks (the catalogue of 32) are fixed for a version of the site, so once they have arrived they are not read again;
//   - `reload()` reads the people and the roles again: it is what a tab calls after a write. It reads the ticks as well when they have not arrived (a first load that failed), which
//     makes it the "Try again" of the screen;
//   - what is on screen never goes away because a read failed: a reload that fails keeps the lists and says why (a temporary password shown once must not vanish together with a
//     list that could not be read again). A first load that fails has nothing to keep, and says why;
//   - when two reads overlap, the one that started last decides, so a slow old answer cannot undo a newer one.
import { isApiError, type ApiClient } from '@/lib/api/client';
import type { SuperPerson, SuperRole, SuperTicksResponse, TickInfo } from '@/lib/api/types';

export type SuperStatus = 'loading' | 'ready' | 'error';

/** The catalogue of ticks as the API sends it: the groups in screen order and the ticks in catalogue order. */
export type SuperTicks = SuperTicksResponse;

export interface SuperState {
  status: SuperStatus;
  /** The sentence of the last read that failed, or null. */
  error: string | null;
  /** The catalogue of ticks, or null until it has arrived. */
  ticks: SuperTicks | null;
  people: SuperPerson[];
  roles: SuperRole[];
}

export interface SuperStore {
  state(): SuperState;
  /** Loads everything when the screen opens. Asked again (React draws an effect twice in development) it does not load again. */
  open(): Promise<void>;
  /** The people and the roles again, and the ticks too when they never arrived. Never rejects: a failure is in the state. */
  reload(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** What the screen says when a read failed and there is no sentence of the client's to say. */
export const COULD_NOT_LOAD = 'Could not load People & Roles. Try again.';

/** The three reads of the screen: the part of the client the store needs. */
type Reads = Pick<ApiClient, 'superTicks' | 'superPeople' | 'superRoles'>;

const START: SuperState = { status: 'loading', error: null, ticks: null, people: [], roles: [] };

/** The words for a read that failed: the client's own sentence for the person, else the plain one. Nothing else is ever shown of an error. */
function sentenceOf(cause: unknown): string {
  return isApiError(cause) && cause.message.trim() !== '' ? cause.message : COULD_NOT_LOAD;
}

/** A list of an answer, or a failed load: an answer that is not in the agreed shape must not pass for an empty list ("nobody has a login"). */
function listOf<T>(answer: unknown, field: string): T[] {
  const list = (answer as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(list)) throw new Error(`The answer has no list called ${field}.`);
  return list as T[];
}

export function createSuperStore(client: Reads): SuperStore {
  let held: SuperState = START;
  let latest = 0;
  let first: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: SuperState) => {
    held = next;
    for (const listener of Array.from(listeners)) listener();
  };

  async function load(): Promise<void> {
    latest += 1;
    const mine = latest;
    const keptTicks = held.ticks;
    // with nothing to show (a retry after a first load that failed) the screen says it loads again; with something to show it stays as it is until the answer is in
    if (keptTicks === null && held.status !== 'loading')
      set({ ...held, status: 'loading', error: null });
    try {
      const [freshTicks, peopleAnswer, rolesAnswer] = await Promise.all([
        keptTicks === null ? client.superTicks() : Promise.resolve(null),
        client.superPeople(),
        client.superRoles(),
      ]);
      const next: SuperState = {
        status: 'ready',
        error: null,
        ticks:
          freshTicks === null
            ? keptTicks
            : {
                groups: listOf<string>(freshTicks, 'groups'),
                ticks: listOf<TickInfo>(freshTicks, 'ticks'),
              },
        people: listOf<SuperPerson>(peopleAnswer, 'people'),
        roles: listOf<SuperRole>(rolesAnswer, 'roles'),
      };
      if (mine === latest) set(next);
    } catch (cause) {
      if (mine === latest) set({ ...held, status: 'error', error: sentenceOf(cause) });
    }
  }

  return {
    state: () => held,
    open: () => {
      if (first === null) first = load();
      return first;
    },
    reload: () => load(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
