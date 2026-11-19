import React, { useId } from 'react';
import SaveButton from '@/components/ui/SaveButton';
import { saveHint } from '../lib/understandHint';

// The two buttons of the Edit role screen, "Cancel" and "Save changes", with the line that says what Save will ask for (plan: access and roles, Task 25; the pictures are
// mockups/3-edit-role.png and 5-phone.png). The screen draws them twice, as the pictures do: in the header on a tablet and a desktop, and in a bar that sticks to the bottom of the page on a
// phone (`EditRoleView`); only one of the two is ever shown, the other is `display: none`, so a keyboard or a screen reader meets one pair.
//   - Save is off until something changed, the name is fine and the box "I understand" (when there is one) is ticked; the line under it says "Tick “I understand” first." when that is what
//     is missing, and otherwise that Save asks for the password. The line is tied to the button for a screen reader. When it is the first it is a BUTTON that takes her to the box (`onShowBox`,
//     `goToBox` of understandHint.ts): on a phone the box is at the top of the editor and this bar is at the bottom (final review of the website, M5);
//   - Save does not save: it goes on to the password step (`ConfirmPasswordDialog`), where the write is done.

export default function SaveBar({
  testId,
  canSave,
  needsBox,
  onCancel,
  onSave,
  onShowBox,
}: {
  /** Prefix of the test ids of the buttons and the hint: `edit-role-head` gives `edit-role-head-save` and `edit-role-head-hint`. */
  testId: string;
  canSave: boolean;
  /** The box "I understand" is there and not ticked: it is what stops Save. */
  needsBox: boolean;
  onCancel: () => void;
  onSave: () => void;
  /** Takes her to the box: the hint is a button that calls it while the box is what stops Save. */
  onShowBox: () => void;
}) {
  const hintId = useId();
  const hint = saveHint(needsBox);
  return (
    <div>
      <div className="flex gap-2.5">
        <button
          type="button"
          data-testid={`${testId}-cancel`}
          onClick={onCancel}
          className="btn-secondary flex-1 justify-center py-2.5 md:flex-none"
        >
          Cancel
        </button>
        <SaveButton
          type="button"
          data-testid={`${testId}-save`}
          disabled={!canSave}
          aria-describedby={hintId}
          onClick={onSave}
          className="btn-primary flex-1 justify-center py-2.5 md:flex-none"
        >
          Save changes
        </SaveButton>
      </div>
      {hint.kind === 'go-to-box' ? (
        <button
          type="button"
          id={hintId}
          data-testid={`${testId}-hint`}
          onClick={onShowBox}
          className="mt-1.5 block w-full text-center text-xs font-semibold text-foreground underline underline-offset-2 md:text-right"
        >
          {hint.text}
        </button>
      ) : (
        <p
          id={hintId}
          data-testid={`${testId}-hint`}
          className="mt-1.5 text-center text-xs text-muted-foreground md:text-right"
        >
          {hint.text}
        </p>
      )}
    </div>
  );
}
