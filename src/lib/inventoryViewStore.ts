'use client';

import { useSyncExternalStore } from 'react';

// Grid or table: the one choice of the Inventory screen, kept here so that the switch in the header and the one above the grid are the same switch (they used to be two
// separate bits of state, and the header's did nothing). The shape is the one of the other stores: module state and a subscription for `useSyncExternalStore`, nothing in
// browser storage. The grid clears it when the screen is left, so the screen opens on the grid each time, as it always did.

export type InventoryView = 'grid' | 'table';

let current: InventoryView = 'grid';
const listeners = new Set<() => void>();

export function getInventoryView(): InventoryView {
  return current;
}

export function subscribeInventoryView(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setInventoryView(view: InventoryView): void {
  if (view === current) return;
  current = view;
  for (const listener of [...listeners]) listener();
}

/** Back to the grid. Tells nobody when it was there already. */
export function resetInventoryView(): void {
  setInventoryView('grid');
}

/** The view, and a re-render of the component that reads it when it changes. */
export function useInventoryView(): InventoryView {
  return useSyncExternalStore(subscribeInventoryView, getInventoryView, () => 'grid');
}
