import React, { useId } from 'react';
import SaveButton from '@/components/ui/SaveButton';
import { PASSWORD_HINT, UNDERSTAND_FIRST } from '../lib/editWords';

// The two buttons of the Edit role screen, "Cancel" and "Save changes", with the line that says what Save will ask for (plan: access and roles, Task 25; the pictures are
// mockups/3-edit-role.png and 5-phone.png). The screen draws them twice, as the pictures do: in the header on a tablet and a desktop, and in a bar that sticks to the bottom of the page on a
// phone (`EditRoleView`); only one of the two is ever shown, the other is `display: none`, so a keyboard or a screen reader meets one pair.
//   - Save is off until something changed, the name is fine and the box "I understand" (when there is one) is ticked; the line under it says "Tick “I understand” first." when that is what
//     is missing, and otherwise that Save asks for the password. The line is tied to the button for a screen reader;
//   - Save does not save: it goes on to the password step (`ConfirmPasswordDialog`), where the write is done.

export default function SaveBar({
  testId,
  canSave,
  needsBox,
  onCancel,
  onSave,
}: {
  /** Prefix of the test ids of the two buttons: `edit-role-head` gives `edit-role-head-save`. */
  testId: string;
  canSave: boolean;
  /** The box "I understand" is there and not ticked: it is what stops Save. */
  needsBox: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const hintId = useId();
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
      <p id={hintId} className="mt-1.5 text-center text-xs text-muted-foreground md:text-right">
        {needsBox ? UNDERSTAND_FIRST : PASSWORD_HINT}
      </p>
    </div>
  );
}
