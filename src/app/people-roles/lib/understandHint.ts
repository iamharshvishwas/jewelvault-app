// The hint under Save of the Edit role screen when the box "I understand" is what stops it (plan: access and roles, Task 25; final review of the website, M5), as plain TypeScript with no
// React, so that the tests read it without a window.
//   - on a phone the box of a sensitive tick is at the TOP of the editor, and the bar that sticks to the bottom of the page said "Tick “I understand” first.": nothing took her to the box. The hint
//     is a button then (`saveHint`), and what it does is `goToBox`: scroll the box to the middle of the screen and give its check box the cursor. When the box is not what stops Save the
//     hint is the plain line that Save asks for the password, and nothing is pressed;
//   - `goToBox` is given the element and calls two of its methods, so a test gives it a stand-in; the element itself is the ref of the check box (`EditRoleView` holds it, `Understand` hangs it).
import { PASSWORD_HINT, UNDERSTAND_FIRST } from './editWords';

/** What the line under Save is: a way to the box (the box is what stops Save), or the plain line about the password. */
export type SaveHint = { kind: 'go-to-box'; text: string } | { kind: 'plain'; text: string };

/** The line under Save, and whether it is a way to the box: it is exactly when the box is what stops Save. */
export function saveHint(needsBox: boolean): SaveHint {
  return needsBox
    ? { kind: 'go-to-box', text: UNDERSTAND_FIRST }
    : { kind: 'plain', text: PASSWORD_HINT };
}

/** The two things `goToBox` asks of the box: an element has them. */
export interface BoxLike {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
}

/**
 * Takes her to the box: scrolls it to the middle of the screen (the bar at the bottom of a phone must not cover it, and the page has `scroll-behavior: smooth`), then gives its check box the
 * cursor without scrolling again. Answers whether it went: there is no box on the page when nothing sensitive is newly on.
 */
export function goToBox(box: BoxLike | null): boolean {
  if (box === null) return false;
  box.scrollIntoView({ block: 'center' });
  box.focus({ preventScroll: true });
  return true;
}
