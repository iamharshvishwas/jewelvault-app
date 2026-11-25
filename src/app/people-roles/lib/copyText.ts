// The Copy button of the temporary password (plan: access and roles, Task 23): copies a text with the clipboard of the browser, and says whether it could. It never throws: a page that is
// not secure, an old browser and a browser that refuses all have no clipboard to write to, and the dialog then says "Copy it by hand".

/** The part of the clipboard of the browser that this uses. */
export type ClipboardWriter = Pick<Clipboard, 'writeText'>;

const browserClipboard = (): ClipboardWriter | undefined => globalThis.navigator?.clipboard;

/**
 * True when the text was copied. `null` is "no clipboard"; leaving it out asks the browser for its own. The browser is asked inside the `try` too: a page that refuses to hand over its
 * clipboard (a getter that throws) is "could not copy", like every other refusal.
 */
export async function copyText(text: string, clipboard?: ClipboardWriter | null): Promise<boolean> {
  try {
    const target = clipboard === undefined ? browserClipboard() : clipboard;
    if (!target || typeof target.writeText !== 'function') return false;
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}
