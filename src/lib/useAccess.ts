'use client';

// What the person who is signed in may do, for the components (plan: access and roles, Task 17, R15): the ticks and the Super Admin flag of the session, as `me` said
// them, in the shape src/lib/access.ts decides with (`can`, `canAny`, `canAccessPath`). Nobody holds anything until the app is open (status "signedIn"): not while
// loading, not on the login screen, not on the change-password screen.
import { useCallback, useMemo } from 'react';
import { can, type Holder, type TickKey } from '@/lib/access';
import { useSession, type SessionState } from '@/lib/authStore';

/** The Holder of a session state: the person's ticks and flag while the app is open, else null. */
export function holderOf(state: SessionState): Holder | null {
  if (state.status !== 'signedIn' || state.session === null) return null;
  return { permissions: state.session.permissions, isSuperAdmin: state.session.isSuperAdmin };
}

/** The Holder of the person who is signed in, or null. The same object until the session changes. */
export function useHolder(): Holder | null {
  const state = useSession(); // the store hands out a new state object only when something changed
  return useMemo(() => holderOf(state), [state]);
}

/** `can(tick)` for the person who is signed in: false for everything while nobody is. */
export function useCan(): (tick: TickKey) => boolean {
  const holder = useHolder();
  return useCallback((tick: TickKey) => can(holder, tick), [holder]);
}
