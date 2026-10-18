'use client';
import React from 'react';
import { bannerText, useConnectionStatus } from '@/lib/api/connection';
import { usePollState } from '@/lib/cache/poll';

// C7: the banner at the top of the application. "Offline: changes cannot be saved" when the network is unreachable, "Waking up…" while the app is being started; one successful call
// clears it. Reads go on from memory, and every Save control is off while it shows (SaveButton, useSavingAllowed). Below it, once, the plain sentence of a poll that failed for another
// reason (U6: a 403 for a role that has not changed; a server error): the screen keeps what it has and tries again by itself.
export default function ConnectionBanner() {
  const status = useConnectionStatus();
  const poll = usePollState();
  const text = bannerText(status);
  if (text) {
    return (
      <div
        role="status"
        data-testid="connection-banner"
        data-state={status}
        className={`flex-shrink-0 px-4 py-1.5 text-center text-xs font-semibold ${
          status === 'offline'
            ? 'bg-red-100 text-red-800 border-b border-red-200'
            : 'bg-amber-100 text-amber-900 border-b border-amber-200'
        }`}
      >
        {text}
      </div>
    );
  }
  if (poll.notice) {
    return (
      <div
        role="status"
        data-testid="poll-notice"
        className="flex-shrink-0 px-4 py-1.5 text-center text-xs font-semibold bg-amber-100 text-amber-900 border-b border-amber-200"
      >
        The latest changes could not be loaded. {poll.notice}
      </div>
    );
  }
  return null;
}
