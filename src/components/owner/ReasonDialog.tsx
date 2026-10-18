'use client';
import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle, Loader2, X } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { forgetOwnerTries } from '@/lib/appStore';
import { getPollState, usePollState } from '@/lib/cache/poll';
import { buildReasonBody, REASON_MAX, REASON_MIN, type ActionFailure } from '@/lib/ownerActions';

// The dialog of an action that needs a reason: cancelling a bill (X5) and voiding a receipt (X4) (spec C5 (b), C6, C7, C13, C17; task WEB11). It asks for the reason (3 to 500 characters),
// sends the action once (a second click while it is on its way is ignored, C6), shows the result only from the API's answer, and says in plain words why a refusal happened and whether
// anything was changed. When the outcome cannot be confirmed it says so and the client reads the customer's books at once (the poll that follows every write, C17); pressing the button
// again sends the same Idempotency-Key, so the action is never done twice (L5). Closing the dialog ends the user action.

interface ReasonDialogProps {
  /** Prefix of the test ids, for example `cancel` (`cancel-dialog`, `cancel-reason`, `cancel-confirm`, `cancel-error`, `cancel-done`). */
  testId: string;
  title: string;
  intro: React.ReactNode;
  confirmLabel: string;
  savingLabel: string;
  /** The label above the reason field. */
  reasonLabel?: string;
  /** Sends the action with the cleaned reason and resolves with what to show once the API has answered. */
  run: (reason: string) => Promise<React.ReactNode>;
  /** The plain sentence for whatever `run` threw. */
  failureOf: (error: unknown) => ActionFailure;
  onClose: () => void;
}

/** "Updating the figures…" until a poll has finished after the answer: the screen never shows the books as they were before the action. */
export function FiguresNote({ polledAt }: { polledAt: number }) {
  const poll = usePollState();
  return (
    <p data-testid="figures-note" className="mt-2 text-xs text-muted-foreground">
      {poll.polls > polledAt
        ? 'The figures on the screen are up to date.'
        : 'Updating the figures…'}
    </p>
  );
}

export default function ReasonDialog({
  testId,
  title,
  intro,
  confirmLabel,
  savingLabel,
  reasonLabel = 'Reason',
  run,
  failureOf,
  onClose,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [done, setDone] = useState<{ view: React.ReactNode; polledAt: number } | null>(null);
  // C6: a second click before the first answer is ignored. The ref answers at once, before the button has been drawn disabled.
  const inFlight = useRef(false);

  // the dialog being closed ends the user action: an action that could not be confirmed is not asked for again with its old key
  useEffect(() => forgetOwnerTries, []);

  const handleConfirm = async () => {
    if (inFlight.current || done) return;
    const built = buildReasonBody(reason);
    if ('error' in built) {
      setFailure({ message: built.error, unconfirmed: false });
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const view = await run(built.body.reason);
      setDone({ view, polledAt: getPollState().polls });
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-label={title}
        data-testid={`${testId}-dialog`}
        className="jewel-card w-full max-w-lg p-6 space-y-4 slide-up"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-foreground">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="btn-ghost p-1.5">
            <X size={16} />
          </button>
        </div>

        {done ? (
          <div data-testid={`${testId}-done`} className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-emerald-700 font-semibold">
              <CheckCircle size={18} /> Done
            </div>
            {done.view}
            <FiguresNote polledAt={done.polledAt} />
            <button
              type="button"
              data-testid={`${testId}-close`}
              onClick={onClose}
              className="btn-secondary mt-3 py-2 text-xs"
            >
              Close
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            className="space-y-4"
          >
            <div className="text-sm text-foreground space-y-2">{intro}</div>
            <fieldset disabled={saving} className="min-w-0">
              <label className="text-xs font-semibold text-foreground block">
                {reasonLabel}
                <textarea
                  data-testid={`${testId}-reason`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={`${REASON_MIN} to ${REASON_MAX} characters`}
                  rows={3}
                  maxLength={REASON_MAX + 200}
                  className="input-field resize-none text-sm mt-1.5 font-normal"
                />
              </label>
            </fieldset>
            {failure && (
              <p
                role="alert"
                data-testid={`${testId}-error`}
                data-unconfirmed={failure.unconfirmed ? 'true' : 'false'}
                className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
              >
                {failure.message}
              </p>
            )}
            <div className="flex gap-3">
              <SaveButton
                type="submit"
                data-testid={`${testId}-confirm`}
                disabled={saving}
                className="btn-primary flex-1 justify-center py-2.5"
              >
                {saving ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    {savingLabel}
                  </>
                ) : (
                  confirmLabel
                )}
              </SaveButton>
              <button type="button" onClick={onClose} className="btn-secondary py-2.5">
                Keep it
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
