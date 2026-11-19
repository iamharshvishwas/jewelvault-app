'use client';
import React, { useEffect, useId, useRef, useState } from 'react';
import { copyText } from '../lib/copyText';
import { sessionsEndedLine } from '../lib/people';
import type { TemporaryPassword } from '../lib/personWrite';
import { warnBeforeUnload } from '../lib/unloadGuard';

// The temporary password of a new person or of a reset, shown once (plan: access and roles, Task 23; API Task 14: it is made by the API, hashed, and never kept or sent again).
//   - it is in a box that can be selected by hand, and a Copy button copies it. Where the browser gives no clipboard, or refuses, the dialog says "Copy it by hand";
//   - there is one way out: "I have copied it". No close cross and no Escape, so that a slip does not lose a password that cannot be shown again (another reset makes a new one);
//   - the password is in the state of the dialog that holds it and in this box, nowhere else: not in an address, a log line, storage or an attribute. Closing the dialog empties it;
//   - a reload or closing the tab would lose it for good, so while this dialog is on screen the browser asks first (`warnBeforeUnload`, the very listener of the Edit role screen; final review of the
//     website, M1). The sidebar and Back are moves inside the page, which `beforeunload` never sees: not covered, as for the editor.

export default function TemporaryPasswordDialog({
  temporary,
  onDone,
}: {
  temporary: TemporaryPassword;
  onDone: () => void;
}) {
  const { kind, name, email, password, sessionsEnded } = temporary;
  const titleId = useId();
  const copyButton = useRef<HTMLButtonElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const signedOut = sessionsEndedLine(sessionsEnded);

  useEffect(() => {
    copyButton.current?.focus();
  }, []);

  // a reload or closing the tab loses a password that cannot be shown again: the browser asks first while this dialog is up, and no more once it is gone
  useEffect(() => {
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, []);

  const onCopy = async () => setCopy((await copyText(password)) ? 'copied' : 'failed');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="temporary-password-dialog"
        className="jewel-card w-full max-w-md max-h-[90vh] overflow-y-auto p-6 space-y-4 slide-up"
      >
        <h2 id={titleId} className="text-base font-bold text-foreground">
          {kind === 'add' ? 'Person added' : 'Password reset'}
        </h2>
        <p className="text-sm text-foreground">
          {kind === 'add'
            ? `${name} can now sign in with ${email} and this temporary password.`
            : `This is the new temporary password for ${name}.`}
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <code
            data-testid="temporary-password"
            className="flex-1 select-all break-all rounded-sm border border-border bg-secondary px-4 py-3 text-center font-mono text-lg font-semibold tracking-wider text-foreground"
          >
            {password}
          </code>
          <button
            ref={copyButton}
            type="button"
            data-testid="temporary-password-copy"
            onClick={() => void onCopy()}
            className="btn-secondary justify-center py-2.5"
          >
            Copy
          </button>
        </div>
        <p
          role="status"
          data-testid="temporary-password-copy-note"
          className={`min-h-4 text-xs font-semibold ${copy === 'failed' ? 'text-red-700' : 'text-emerald-700'}`}
        >
          {copy === 'copied' ? 'Copied.' : copy === 'failed' ? 'Copy it by hand.' : ''}
        </p>

        <p className="text-sm text-muted-foreground">
          {`It is shown only once. ${name} must change it the first time they sign in.`}
        </p>
        {signedOut && (
          <p data-testid="temporary-password-signed-out" className="text-sm text-muted-foreground">
            {signedOut}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            data-testid="temporary-password-done"
            onClick={onDone}
            className="btn-primary justify-center py-2.5"
          >
            I have copied it
          </button>
        </div>
      </div>
    </div>
  );
}
