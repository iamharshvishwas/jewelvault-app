// The Copy button of the temporary password (plan: access and roles, Task 23): copies a text with the clipboard of the browser, and says whether it could. It never throws: a page that is
// not secure, an old browser and a browser that refuses all have no clipboard to write to, and the dialog then says "Copy it by hand".

/** The part of the clipboard of the browser that this uses. */
export type ClipboardWriter = Pick<Clipboard, 'writeText'>;

const browserClipboard = (): ClipboardWriter | undefined => globalThis.navigator?.clipboard;

/** True when the text was copied. `null` is "no clipboard"; leaving it out asks the browser for its own. */
export async function copyText(
  text: string,
  clipboard: ClipboardWriter | null | undefined = browserClipboard()
): Promise<boolean> {
  try {
    if (!clipboard || typeof clipboard.writeText !== 'function') return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
