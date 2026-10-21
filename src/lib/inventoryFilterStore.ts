'use client';

import { useSyncExternalStore } from 'react';
import { NO_FILTER, type FilterSection, type InventoryFilter } from './inventoryFilter';

// What the Inventory screen's filter panel has ticked and typed, kept in this page for the panel (which writes it) and for the grid, the table and the header (which read it).
// The shape is the one the other stores of the app have: module state, a subscription for `useSyncExternalStore`, and nothing in browser storage. Every change makes a NEW
// object, so a screen that keeps "the filter I last showed" knows by identity that it changed (the grid goes back to page 1 that way). The panel clears it when the screen is
// left, so a design added elsewhere is never hidden by a tick nobody remembers.

let current: InventoryFilter = NO_FILTER;
const listeners = new Set<() => void>();

function publish(next: InventoryFilter): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

export function getInventoryFilter(): InventoryFilter {
  return current;
}

export function subscribeInventoryFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ticks an option, or takes the tick away when it is there. */
export function toggleInventoryOption(section: FilterSection, option: string): void {
  const ticked = current[section];
  publish({
    ...current,
    [section]: ticked.includes(option)
      ? ticked.filter((item) => item !== option)
      : [...ticked, option],
  });
}

export function setInventorySearch(search: string): void {
  publish({ ...current, search });
}

/** Sets one end of the weight range, as typed. */
export function setInventoryWeight(end: 'min' | 'max', text: string): void {
  publish(end === 'min' ? { ...current, weightMin: text } : { ...current, weightMax: text });
}

/** Back to nothing set. Tells nobody when nothing was set. */
export function clearInventoryFilter(): void {
  if (current !== NO_FILTER) publish(NO_FILTER);
}

/** The filter, and a re-render of the screen that reads it when it changes. */
export function useInventoryFilter(): InventoryFilter {
  return useSyncExternalStore(subscribeInventoryFilter, getInventoryFilter, () => NO_FILTER);
}
