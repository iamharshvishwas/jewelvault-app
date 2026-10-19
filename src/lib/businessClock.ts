'use client';

// Today's business date (S5) for a screen that stays open: it is drawn again when the Asia/Kolkata day changes, and says nothing in the static HTML (that would be the day of the
// build, and the page would not match what the browser draws). WEB12: the evening check watches the cash book of "today", so it has to notice midnight.
import { useSyncExternalStore } from 'react';
import { businessDateOf } from './selectors';

/** India has no daylight saving time; its offset from UTC has been +05:30 since 1945. */
const INDIA_OFFSET_MS = 19_800_000;
const MS_PER_DAY = 86_400_000;
const SLACK_MS = 1_000;

/** Milliseconds from `now` to the next midnight in India. */
export function msToNextBusinessMidnight(now: number = Date.now()): number {
  return MS_PER_DAY - ((now + INDIA_OFFSET_MS) % MS_PER_DAY);
}

/** Calls `onChange` shortly after each midnight in India, and when the tab is shown again (a computer that slept through midnight). Returns the way to stop. */
export function subscribeToNewDay(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      onChange();
      arm();
    }, msToNextBusinessMidnight() + SLACK_MS);
  };
  arm();
  const shown = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') onChange();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', shown);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', shown);
  };
}

/** Today's business date, YYYY-MM-DD; the empty text while the page is made on the server. */
export function useBusinessToday(): string {
  return useSyncExternalStore(
    subscribeToNewDay,
    () => businessDateOf(Date.now()),
    () => ''
  );
}
