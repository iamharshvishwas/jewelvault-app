'use client';

// A screen that shows what is in memory has to be drawn again when memory changes: a poll brought somebody else's change, or its own edit was written or rolled back (C4, C5).
// This is the one way a component hears of it. The text it returns changes whenever one of the named resources changes (cache.ts `versionOf`); the server render, which has no
// memory, says the empty text. Task WEB05.
import { useSyncExternalStore } from 'react';
import type { SyncResource } from '@/lib/api/types';
import { rowCache } from './cache';

export function useRowCacheVersion(...resources: SyncResource[]): string {
  return useSyncExternalStore(
    rowCache.subscribe,
    () => rowCache.versionOf(...resources),
    () => ''
  );
}
