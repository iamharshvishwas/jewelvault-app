'use client';
import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

// The frame of the forms that come before the password step (plan: access and roles, Task 23): the same dialog as ConfirmPasswordDialog (the picture is mockups/4-password-confirm.png),
// with the fields of the form in it. Nothing is saved here: the button goes on to the password step, which says so under the fields.
//   - Escape closes it, anywhere on the page (the same as ConfirmPasswordDialog). The caller shows this INSTEAD of the password step, never together with it, so the two never listen
//     for Escape at the same time;
//   - the cursor is in the first field when it opens.

export interface FormDialogProps {
  /** Prefix of the test ids: `add-person` gives `add-person-dialog`. */
  testId: string;
  title: string;
  /** A line under the title, or nothing. */
  intro?: React.ReactNode;
  /** What is wrong with the form as a whole (not with one field), or null. */
  formError?: string | null;
  onSubmit: () => void;
  onClose: () => void;
  /** The fields. */
  children: React.ReactNode;
}

const PASSWORD_NEXT = 'Next, you will be asked for your password.';

export default function FormDialog({
  testId,
  title,
  intro,
  formError = null,
  onSubmit,
  onClose,
  children,
}: FormDialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={`${testId}-dialog`}
        className="jewel-card w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4 slide-up"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-bold text-foreground">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="btn-ghost p-1.5">
            <X size={16} />
          </button>
        </div>

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
          className="space-y-4"
        >
          {intro ? <div className="text-sm text-foreground space-y-2">{intro}</div> : null}
          {children}
          {formError && (
            <p
              role="alert"
              data-testid={`${testId}-error`}
              className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
            >
              {formError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{PASSWORD_NEXT}</p>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              data-testid={`${testId}-cancel`}
              onClick={onClose}
              className="btn-secondary py-2.5"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid={`${testId}-continue`}
              className="btn-primary justify-center py-2.5"
            >
              Continue
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
