// Leaving the page itself with edits that are not saved (plan: access and roles, Task 24b; found by the first real-browser run, Task 26 part 1). A reload, or closing the tab, goes to the
// browser and takes everything the Edit role screen holds with it; nothing on the screen can ask, but the browser has a question of its own for that, which a page asks for by cancelling the
// `beforeunload` event. As plain TypeScript with no React, so that the tests read it without a window.
//   - it is asked only while there is something to lose: the editor has edits that are not saved (`dirty`, as `infoOf` counts them). A role that is saved, an editor with nothing changed and
//     every other screen leave without a question; the editor adds the listener while it has edits and removes it otherwise and when it goes away;
//   - sidebar links and the browser's Back are moves inside the page (client-side navigation): `beforeunload` never sees them, and this does not cover them;
//   - the browser shows its own words and ignores any text of ours, so none is set: `returnValue` is set to an empty text, which is still a value, as the browsers that want it need;
//   - this is not a key listener: the Escape handling of the screens is untouched.

/** Whether a reload or closing the tab asks first: while there are edits that are not saved. */
export function shouldWarnOnUnload(dirty: boolean): boolean {
  return dirty;
}

/** The `beforeunload` listener of the editor: cancels the unload, so that the browser asks, and sets `returnValue` for the browsers that want it. */
export function warnBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}
