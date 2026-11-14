// Wave 2 fix 2 (I2): waits for the pictures of a page before it is printed. A catalogue of hundreds of designs draws its photos lazily on the screen; for paper they are switched to eager and the
// print waits here until each one has loaded and been decoded, or has failed, or `timeoutMs` has gone by: a photo that never arrives must not stop a paper from printing.

/** Resolves when the one picture is loaded and decoded, or cannot be (a broken address is an answer too). Never rejects. */
function imageSettled(img: HTMLImageElement): Promise<void> {
  if (typeof img.decode === 'function') {
    return img.decode().then(
      () => undefined,
      () => undefined
    );
  }
  return new Promise<void>((resolve) => {
    if (img.complete) {
      resolve();
      return;
    }
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}

/**
 * Resolves when every `<img>` under `root` has settled (loaded and decoded, or failed) or when `timeoutMs` has gone by, whichever comes first. A page with no picture resolves at once. Never
 * rejects.
 */
export function imagesSettled(
  root: Pick<ParentNode, 'querySelectorAll'> | null,
  timeoutMs: number
): Promise<void> {
  const images = root ? Array.from(root.querySelectorAll<HTMLImageElement>('img')) : [];
  if (images.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void Promise.all(images.map(imageSettled)).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
