'use client';

// Who is offered the owner's actions (spec A4, X4, X5, X10, X11, X12; task WEB11): the owner of a real build, and nobody else. A biller and a staff user are shown none of them (the buttons
// are not drawn at all, not greyed out), and the API refuses them anyway (JV_FORBIDDEN, the wall). A preview build has no server to send them to, so it offers none either.
import { useSession } from '@/lib/authStore';
import { PREVIEW_MODE } from '@/lib/previewMode';

export function useOwnerActions(): boolean {
  const { role } = useSession();
  return !PREVIEW_MODE && role === 'owner';
}
