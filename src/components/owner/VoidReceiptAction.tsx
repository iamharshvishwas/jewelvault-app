'use client';
import React, { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { getReceiptFacts, saveVoid } from '@/lib/appStore';
import { inr } from '@/lib/billing';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { ownerActionFailure, savedVoidFrom, type SavedVoid } from '@/lib/ownerActions';
import { formatGrams } from '@/lib/pricing';
import ReasonDialog from './ReasonDialog';
import { useOwnerActions } from './useOwnerActions';

// The owner's VOID of a receipt (X4; spec Y7, Y10, S7; task WEB11). A receipt is never deleted: it stays, tagged Voided, and the bills it paid owe that money again; money that was waiting
// as an advance pays them. A payment whose money was already handed back as a refund cannot be voided until that refund is voided: the dialog explains it before the owner presses, and
// the API's refusal ("Void the refund first", with how much was handed back) is said in words if it happens anyway.

interface VoidReceiptActionProps {
  receiptId: string;
  /** What the receipt is, in a few words, for the title and the sentence: "₹500 by UPI on 5 Oct". */
  label: string;
  /** A refund is voided to give its money back to the advance. */
  refund?: boolean;
}

const part = (paise: number) => inr(paise, paise % 100 !== 0);

function VoidDone({ saved }: { saved: SavedVoid }) {
  return (
    <div className="space-y-1.5 text-xs text-foreground">
      <p data-testid="void-result" className="text-sm font-semibold">
        The receipt is void.
      </p>
      {saved.bills.length > 0 && (
        <ul data-testid="void-bills" className="space-y-0.5">
          {saved.bills.map((bill) => (
            <li key={bill.billId}>
              {bill.billNo}:{' '}
              {bill.pendingPaise > 0 ? `${part(bill.pendingPaise)} is pending` : 'nothing pending'}
              {bill.finePendingMg > 0 && `, ${formatGrams(bill.finePendingMg)} g silver pending`}
            </li>
          ))}
        </ul>
      )}
      {saved.appliedElsewherePaise > 0 && (
        <p data-testid="void-applied">
          {part(saved.appliedElsewherePaise)} that was waiting as an advance was applied to the
          bills.
        </p>
      )}
    </div>
  );
}

export default function VoidReceiptAction({
  receiptId,
  label,
  refund = false,
}: VoidReceiptActionProps) {
  const allowed = useOwnerActions();
  useRowCacheVersion('receipts', 'bills');
  const [open, setOpen] = useState(false);
  const facts = getReceiptFacts(receiptId);
  if (!allowed || !facts) return null;

  // the button goes as soon as the receipt is void, but the dialog stays until the owner closes it: it holds the answer (or the words of an outcome that could not be confirmed)
  return (
    <>
      {facts.status === 'active' && (
        <button
          type="button"
          data-testid={refund ? 'void-refund' : 'void-receipt'}
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-sm border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
        >
          <Undo2 size={13} /> Void
        </button>
      )}
      {open && (
        <ReasonDialog
          testId="void"
          title={refund ? `Void the refund of ${label}` : `Void the receipt of ${label}`}
          intro={
            refund ? (
              <>
                <p>
                  Voiding this refund gives {label} back to the customer&apos;s advance. The refund
                  stays in the books, tagged Voided, with your reason.
                </p>
              </>
            ) : (
              <>
                <p>
                  The receipt of {label} stays in the books, tagged Voided, with your reason. The
                  bills it paid owe that money again.
                </p>
                <p className="text-xs text-muted-foreground">
                  If the customer has been handed money back out of this payment, void that refund
                  first (Payments tab, Refunds): the system will not let a payment be voided while
                  its money is already out.
                </p>
              </>
            )
          }
          reasonLabel="Why is it void?"
          confirmLabel="Void it"
          savingLabel="Voiding…"
          run={async (reason) => {
            const answer = await saveVoid(facts.customerId, facts.id, { reason });
            return <VoidDone saved={savedVoidFrom(answer)} />;
          }}
          failureOf={(error) => ownerActionFailure(error, { action: 'void' })}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
