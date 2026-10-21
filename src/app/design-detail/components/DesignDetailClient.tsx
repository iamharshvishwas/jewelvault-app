'use client';
import React, { useSyncExternalStore } from 'react';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { getDesigns } from '@/lib/designStore';
import { designOfPage } from './designOfPage';
import DesignDetailView from './DesignDetailView';

// The one place where the design page reads its address and its design (the cleanup of 19 October; before it, each of the three parts read the address on its own and fell back to the first
// design of the list). The design comes from the store, which reads the cache after the loading gate (C2, C9); in the preview build it is the preview's sample store.

const noSubscription = () => () => {};
/** The `id` of the address, read when the page is drawn (the page is left and opened again for another design). */
const readIdFromUrl = () => new URLSearchParams(window.location.search).get('id');
/** What the designs of `getDesigns()` are made from: when one of these changes, the page is drawn again. */
const DESIGN_RESOURCES = [
  'designs',
  'skus',
  'categories',
  'subcategories',
  'users',
  'sku-private',
] as const;

export default function DesignDetailClient() {
  useRowCacheVersion(...DESIGN_RESOURCES);
  const wantedId = useSyncExternalStore(noSubscription, readIdFromUrl, () => null);
  return <DesignDetailView state={designOfPage(getDesigns(), wantedId)} />;
}
