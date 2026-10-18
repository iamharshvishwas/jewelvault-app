'use client';
import React from 'react';
import { useConnectionStatus, bannerText, savingAllowedFor } from '@/lib/api/connection';

// C7: a button that saves something. It is a plain <button> in every way, and it is disabled while the banner "Offline: changes cannot be saved" or "Waking up…" is on screen
// (its title says why). Every control that saves business data uses this, or `useSavingAllowed` where it is not a button. C6 (disabled while a save is running) is the caller's
// `disabled`, which this keeps.
export default function SaveButton({
  disabled,
  title,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const status = useConnectionStatus();
  const blocked = !savingAllowedFor(status);
  return (
    <button
      {...rest}
      disabled={disabled || blocked}
      title={blocked ? (bannerText(status) ?? title) : title}
    >
      {children}
    </button>
  );
}
