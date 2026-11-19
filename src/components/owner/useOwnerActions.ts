'use client';

// Which of the owner's actions a person is offered (spec A4, X4, X5, X10, X11, X12; tasks WEB11 and 20 of the access plan): each by its own tick, so a role that holds one of them has that button and
// not the others. Today's owner holds all five; a biller and a staff user hold none and are shown none of them (the buttons are not drawn at all, not greyed out), and the API refuses them anyway
// (JV_FORBIDDEN, the wall). A preview build has no server to send them to, so it offers none either. The rule is `ownerActionFlags` of src/lib/ownerActions.ts.
import { useMemo } from 'react';
import { ownerActionFlags, type OwnerActionFlags } from '@/lib/ownerActions';
import { PREVIEW_MODE } from '@/lib/previewMode';
import { useHolder } from '@/lib/useAccess';

export function useOwnerActions(): OwnerActionFlags {
  const holder = useHolder();
  return useMemo(() => ownerActionFlags(holder, PREVIEW_MODE), [holder]);
}
