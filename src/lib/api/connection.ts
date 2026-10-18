'use client';

// The banner of C7 for the screens: is the server reachable, and may a Save control be pressed? The client (client.ts) keeps the state: 'ok', 'waking' (a gateway error or a reply that
// is not JSON: the app is being started) or 'offline' (the network is unreachable). One successful call clears it. Task WEB04.
import { useSyncExternalStore } from 'react';
import { CONNECTION_BANNER, api, type ConnectionStatus } from './client';

/** C7: every Save control is disabled while there is a banner. */
export function savingAllowedFor(status: ConnectionStatus): boolean {
  return status === 'ok';
}

/** The words of the banner for this state, or null when there is none. */
export function bannerText(status: ConnectionStatus): string | null {
  return CONNECTION_BANNER[status];
}

/** The state of the connection. The server and the first client render say "ok", so the HTML matches. */
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(
    api.subscribeConnection,
    api.getConnectionStatus,
    (): ConnectionStatus => 'ok'
  );
}

/** C7: false while "Offline: changes cannot be saved" or "Waking up…" is on screen. Every control that saves reads this (`SaveButton` does it for a button). */
export function useSavingAllowed(): boolean {
  return savingAllowedFor(useConnectionStatus());
}
