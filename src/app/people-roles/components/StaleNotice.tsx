'use client';
import React, { useEffect, useRef } from 'react';
import { ROLES_STALE_NOTICE } from '../lib/roles';

// The line above the list of roles after a switch was refused because the role had been changed by someone else (plan: access and roles, Task 24b; found by the first real-browser run, Task 26
// part 1). The password step has closed by then and the lists were read again, so the row behind this line shows the role as it is now; the line says what happened and leaves the next move to
// her ("Try again if you still want to"): a switch goes the other way from the way the row is, and the other browser may have done it already.
//   - it is an alert, so that it is read out when it appears, and it scrolls into view: the step that was open is gone, and on a phone, scrolled down to a row, a line at the top of the list
//     would be out of sight;
//   - it goes away when she dismisses it, and when she opens a dialog (the tab does that, not this).

export default function StaleNotice({ onDismiss }: { onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div
      ref={box}
      role="alert"
      data-testid="roles-stale-notice"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-[#f1d28a] bg-amber-50 px-3.5 py-2.5 text-sm text-[#7a4d00]"
    >
      <p className="font-semibold">{ROLES_STALE_NOTICE}</p>
      <button
        type="button"
        data-testid="roles-stale-dismiss"
        onClick={onDismiss}
        className="btn-secondary py-2 text-xs"
      >
        Dismiss
      </button>
    </div>
  );
}
