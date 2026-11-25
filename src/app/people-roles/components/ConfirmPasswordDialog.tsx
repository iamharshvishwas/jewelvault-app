'use client';
import React, { useEffect, useId, useReducer, useRef } from 'react';
import { Loader2, X } from 'lucide-react';
import PasswordField from '@/components/ui/PasswordField';
import SaveButton from '@/components/ui/SaveButton';
import { UNCONFIRMED_MESSAGE } from '@/lib/api/errorMap';
import { EMPTY_PASSWORD_DIALOG, passwordDialogReducer } from '../lib/passwordDialog';

// The dialog every write of People & Roles goes through (plan: access and roles, Task 22, R9; the picture is mockups/4-password-confirm.png). It says what is about to happen and asks the
// Super Admin for her own password again; the screen that opened it does the write in `onConfirm` and answers with the sentence of a refusal, or null when it worked.
//   - the password lives only in this dialog's state (`passwordDialogReducer`). It is typed into a password field, goes to `onConfirm` once, and is gone when the answer comes (a refusal
//     as well as success), and when the dialog is closed. It is in no address, no log line, no message and no storage;
//   - one answer at a time: a second press while the first is on its way does nothing, and the dialog cannot be closed in the meantime, so the screen is never told "closed" for a
//     write that is still going on;
//   - on success the caller closes the dialog: it knows what comes next (a list read again, a temporary password shown once). Here the field is only emptied;
//   - a refusal is shown here and the dialog stays open, with the cursor back in the empty field: a wrong password is typed again, a pause says how long it lasts;
//   - Escape closes it (anywhere on the page, since a disabled field gives up the focus while the call is on its way), except while a call is on its way.

export interface ConfirmPasswordDialogProps {
  title: string;
  /** What is about to happen, in words: drawn above the password field. */
  summary: React.ReactNode;
  confirmLabel: string;
  /** Does the write with the password that was typed. Resolves with the sentence to show when it was refused, or with null when it worked. */
  onConfirm: (password: string) => Promise<{ error: string | null }>;
  onClose: () => void;
}

export default function ConfirmPasswordDialog({
  title,
  summary,
  confirmLabel,
  onConfirm,
  onClose,
}: ConfirmPasswordDialogProps) {
  const [state, dispatch] = useReducer(passwordDialogReducer, EMPTY_PASSWORD_DIALOG);
  const titleId = useId();
  const field = useRef<HTMLInputElement>(null);
  // a second press before the first answer does nothing (C6); the ref answers at once, before the button has been drawn disabled
  const inFlight = useRef(false);

  // the cursor is in the field when the dialog opens and comes back to it when an answer has been shown (a disabled field gives up the focus)
  useEffect(() => {
    if (!state.saving) field.current?.focus();
  }, [state.saving]);

  useEffect(() => {
    if (state.saving) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      dispatch({ type: 'closed' });
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.saving, onClose]);

  const close = () => {
    if (state.saving) return;
    dispatch({ type: 'closed' });
    onClose();
  };

  const confirm = async () => {
    if (inFlight.current || state.saving || state.password === '') return;
    inFlight.current = true;
    const typed = state.password;
    dispatch({ type: 'submitted' });
    let outcome: { error: string | null };
    try {
      outcome = await onConfirm(typed);
    } catch {
      // the caller should answer, not throw; if it throws nobody can say what was saved, and nothing of the error is shown
      outcome = { error: UNCONFIRMED_MESSAGE };
    }
    inFlight.current = false;
    dispatch({ type: 'answered', error: outcome.error });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="confirm-password-dialog"
        className="jewel-card w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4 slide-up"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-bold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={state.saving}
            aria-label="Close"
            className="btn-ghost p-1.5"
          >
            <X size={16} />
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
          className="space-y-4"
        >
          <div className="text-sm text-foreground space-y-2">{summary}</div>
          <fieldset disabled={state.saving} className="min-w-0 space-y-1.5">
            <PasswordField
              label="Your password"
              labelClassName="text-xs font-semibold text-foreground block"
              inputClassName="input-field text-sm font-normal"
              fieldClassName="mt-1.5"
              inputRef={field}
              data-testid="confirm-password-input"
              value={state.password}
              onChange={(event) => dispatch({ type: 'typed', password: event.target.value })}
              autoComplete="current-password"
            />
            <p className="text-xs text-muted-foreground">
              We ask for your password every time you change who can do what.
            </p>
          </fieldset>
          {state.error && (
            <p
              role="alert"
              data-testid="confirm-password-error"
              className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
            >
              {state.error}
            </p>
          )}
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              data-testid="confirm-password-cancel"
              onClick={close}
              disabled={state.saving}
              className="btn-secondary py-2.5"
            >
              Cancel
            </button>
            <SaveButton
              type="submit"
              data-testid="confirm-password-confirm"
              disabled={state.saving || state.password === ''}
              className="btn-primary justify-center py-2.5"
            >
              {state.saving ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Confirming…
                </>
              ) : (
                confirmLabel
              )}
            </SaveButton>
          </div>
        </form>
      </div>
    </div>
  );
}
