'use client';

// The one hook the People & Roles screen reads from (plan: access and roles, Task 22). It loads the ticks, the people and the roles once when the screen opens; `reload()` reads the
// people and the roles again and is what a tab calls after a write (`createSuperStore` has the rules). The shell calls it once and hands what it gives to the tabs as props.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api/client';
import { createSuperStore, type SuperState } from './superStore';

export interface SuperView extends SuperState {
  /** The people and the roles again (and the ticks too, if they never arrived): after a write, and for "Try again". */
  reload(): Promise<void>;
}

export function useSuper(): SuperView {
  const [store] = useState(() => createSuperStore(api));
  const state = useSyncExternalStore(store.subscribe, store.state, store.state);
  useEffect(() => {
    void store.open();
  }, [store]);
  return useMemo(() => ({ ...state, reload: store.reload }), [state, store]);
}
