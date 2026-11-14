// FB-B2 (Siddhi #9): reading a tag with the phone's camera. A tag carries a Code 128 (of the piece number) and a QR (of the barcode) (FB-B1); both are read here, and the text that comes out, a piece number or a barcode, is what a typed
// code or a USB scanner would have given the screen.
//   - the browser's own `BarcodeDetector`, when it has one that reads both, is used as it is (nothing to download);
//   - else `@zxing/browser` (plain JavaScript: no WebAssembly, no eval, so the Content-Security-Policy needs nothing new), loaded only when the camera is first opened;
//   - with no camera (an insecure page, a desktop without one) or a camera the person refused there is nothing to start: the screens say so and the typed box stays (Review Focus 4).

/** What the screens say when the camera cannot be used; the typed box is always there beside it. */
export const CAMERA_UNAVAILABLE = 'Camera not available — type the code';

export class CameraUnavailableError extends Error {
  constructor() {
    super(CAMERA_UNAVAILABLE);
    this.name = 'CameraUnavailableError';
  }
}

export type Decoder = 'native' | 'zxing' | 'manual';

/** Which reader to use for what the browser has. No camera means nothing is started at all. */
export function chooseDecoder(env: { hasBarcodeDetector: boolean; hasCamera: boolean }): Decoder {
  if (!env.hasCamera) return 'manual';
  return env.hasBarcodeDetector ? 'native' : 'zxing';
}

/** Passes a code on once while it stays in front of the camera; a different code, then the first one again, is new each time. */
export function onlyNewCodes(onCode: (text: string) => void): (text: string) => void {
  let last: string | null = null;
  return (text) => {
    if (text === last) return;
    last = text;
    onCode(text);
  };
}

// ------------------------------------------------------------------------------------------------ what the browser has

// The Shape Detection API is not in TypeScript's DOM types.
interface DetectedCode {
  rawValue: string;
}
interface NativeDetector {
  detect(source: CanvasImageSource): Promise<DetectedCode[]>;
}
interface NativeDetectorClass {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

const TAG_FORMATS = ['code_128', 'qr_code'];

function nativeDetectorClass(): NativeDetectorClass | null {
  return (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector ?? null;
}

async function browserEnv(): Promise<{ hasBarcodeDetector: boolean; hasCamera: boolean }> {
  const hasCamera =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  let hasBarcodeDetector = false;
  const Detector = nativeDetectorClass();
  if (Detector) {
    try {
      const formats = await Detector.getSupportedFormats();
      hasBarcodeDetector = TAG_FORMATS.every((format) => formats.includes(format));
    } catch {
      hasBarcodeDetector = false;
    }
  }
  return { hasBarcodeDetector, hasCamera };
}

const CAMERA = {
  video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
} satisfies MediaStreamConstraints;

/** How often the native detector looks at the picture. */
const LOOK_EVERY_MS = 150;
/** A look that is not answered in this long is given up. If it was the first one the detector is taken to not work here (some desktop builds have one that never answers). */
const ANSWER_WITHIN_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// ------------------------------------------------------------------------------------------------ the two readers

async function startNative(
  video: HTMLVideoElement,
  onCode: (text: string) => void,
  onUnavailable?: () => void
): Promise<() => void> {
  const Detector = nativeDetectorClass();
  if (!Detector) throw new CameraUnavailableError();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(CAMERA);
  } catch {
    throw new CameraUnavailableError();
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // the picture may start a moment later (or the page was left); the detector looks again each time
  }
  const detector = new Detector({ formats: TAG_FORMATS });
  let stopped = false;
  let answered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** @zxing/browser's stop, once it has taken the camera over. */
  let handedOver: (() => void) | null = null;

  const releaseCamera = () => {
    stream.getTracks().forEach((track) => track.stop());
    // another start may have put its own picture in the same video meanwhile: leave that one alone
    if (video.srcObject === stream) video.srcObject = null;
  };

  // the detector is there but does not work in this browser: @zxing/browser reads the same camera instead. If it cannot (its code did not load, the stream cannot be attached), the screen has
  // already been given its stop function, so it is told here that there is nothing to look at: the camera is let go and the screen says to type the code.
  const handOver = () => {
    startZxing(video, onCode, stream).then(
      (stopZxing) => (stopped ? stopZxing() : (handedOver = stopZxing)),
      () => {
        const wasStopped = stopped;
        stopped = true;
        releaseCamera();
        if (!wasStopped) onUnavailable?.();
      }
    );
  };

  const look = async () => {
    if (stopped) return;
    if (video.readyState >= 2) {
      try {
        const found = await withTimeout(detector.detect(video), ANSWER_WITHIN_MS);
        answered = true;
        if (found[0] && !stopped) onCode(found[0].rawValue);
      } catch {
        if (!answered) {
          if (!stopped) handOver();
          return;
        }
        // one frame that cannot be read is skipped
      }
    }
    if (!stopped) timer = setTimeout(look, LOOK_EVERY_MS);
  };
  void look();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (handedOver) handedOver();
    else releaseCamera();
  };
}

/** `stream`: a camera that is already open (the native reader's), else the reader opens the back camera itself. */
async function startZxing(
  video: HTMLVideoElement,
  onCode: (text: string) => void,
  stream?: MediaStream
): Promise<() => void> {
  try {
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const reader = new BrowserMultiFormatReader(undefined, {
      delayBetweenScanAttempts: 120,
      delayBetweenScanSuccess: 400,
    });
    // a frame with no code in it calls back with an error: only a result matters
    const onResult = (result?: { getText(): string }) => {
      if (result) onCode(result.getText());
    };
    const controls = stream
      ? await reader.decodeFromStream(stream, video, onResult)
      : await reader.decodeFromConstraints(CAMERA, video, onResult);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      controls.stop();
    };
  } catch {
    throw new CameraUnavailableError();
  }
}

/**
 * Opens the back camera in `video` and calls `onCode` with the text of each Code 128 or QR it reads (the same code again and again while it stays in view: `onlyNewCodes` is for that).
 * Resolves with the function that stops it and lets the camera go. Rejects with `CameraUnavailableError` when there is no camera or the person refused it. `onUnavailable` is called, once,
 * when the camera was opened and the scan then cannot go on (the native detector never answers and `@zxing/browser` cannot take over): it is too late to reject, so the screen is told here.
 */
export async function startScan(
  video: HTMLVideoElement,
  onCode: (text: string) => void,
  onUnavailable?: () => void
): Promise<() => void> {
  const decoder = chooseDecoder(await browserEnv());
  if (decoder === 'manual') throw new CameraUnavailableError();
  return decoder === 'native'
    ? startNative(video, onCode, onUnavailable)
    : startZxing(video, onCode);
}
