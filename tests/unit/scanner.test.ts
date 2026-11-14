// FB-B2 (Siddhi #9): the phone camera reads the tags. The decoder is chosen by what the browser has, and a browser with no camera (or no permission) still lets the person type a code.
//
//   - `chooseDecoder`: the browser's BarcodeDetector when it has one and a camera, else @zxing/browser, and 'manual' (no camera work at all) whenever there is no camera (Review Focus 4)
//   - `startScan` with a stand-in camera and detector (node has neither): the native path reports a code, stops its tracks and its timer on stop; a camera that is refused, or none at all,
//     rejects with the one message the screens show; `@zxing/browser`'s own path is proved in a real browser by tests/e2e/scan-camera.spec.ts
//   - a code that stays in front of the camera is reported once (`onlyNewCodes`), a different one after it is reported, and the first again after that
//   - the billing panel and the scan screen offer "Scan with camera" and keep the typed box
//
// Run: npm test -- tests/unit/scanner.test.ts
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA_UNAVAILABLE,
  CameraUnavailableError,
  chooseDecoder,
  onlyNewCodes,
  startScan,
} from '@/lib/scanner';

// @zxing/browser needs a real camera and canvas: a stand-in that records how it was started and lets a test "read" a code.
const zxing = vi.hoisted(() => ({
  started: [] as Array<{ how: 'constraints' | 'stream'; source: unknown }>,
  emit: null as null | ((text: string) => void),
  stopped: 0,
  /** What each way of starting does instead of starting (a refused camera, a stream that cannot be attached). */
  failWith: { constraints: null as Error | null, stream: null as Error | null },
}));
vi.mock('@zxing/browser', () => {
  const start = (how: 'constraints' | 'stream') =>
    vi.fn(async (source: unknown, _video: unknown, callback: (result?: unknown) => void) => {
      zxing.started.push({ how, source });
      const failure = zxing.failWith[how];
      if (failure) throw failure;
      zxing.emit = (text) => callback({ getText: () => text });
      return {
        stop: () => {
          zxing.stopped += 1;
        },
      };
    });
  return {
    BrowserMultiFormatReader: class {
      decodeFromConstraints = start('constraints');
      decodeFromStream = start('stream');
    },
  };
});

afterEach(() => {
  zxing.started.length = 0;
  zxing.emit = null;
  zxing.stopped = 0;
  zxing.failWith.constraints = null;
  zxing.failWith.stream = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('FB-B2 chooseDecoder (Review Focus 4)', () => {
  it("uses the browser's own detector when it has one and there is a camera", () => {
    expect(chooseDecoder({ hasBarcodeDetector: true, hasCamera: true })).toBe('native');
  });

  it('uses @zxing/browser when there is a camera and no detector', () => {
    expect(chooseDecoder({ hasBarcodeDetector: false, hasCamera: true })).toBe('zxing');
  });

  it('is manual (the typed box only) whenever there is no camera, with or without a detector', () => {
    expect(chooseDecoder({ hasBarcodeDetector: true, hasCamera: false })).toBe('manual');
    expect(chooseDecoder({ hasBarcodeDetector: false, hasCamera: false })).toBe('manual');
  });
});

describe('FB-B2 a code in front of the camera is reported once', () => {
  it('drops the same code again and again, reports a different one, and the first once more after it', () => {
    const seen: string[] = [];
    const report = onlyNewCodes((text) => seen.push(text));
    for (const text of ['A', 'A', 'A', 'B', 'B', 'A', 'A']) report(text);
    expect(seen).toEqual(['A', 'B', 'A']);
  });
});

// ================================================================================================ startScan with a stand-in camera

interface FakeTrack {
  stopped: boolean;
  stop(): void;
}

function fakeCamera() {
  const track: FakeTrack = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = {
    srcObject: null as unknown,
    readyState: 4,
    play: vi.fn(async () => undefined),
  };
  return { track, stream, video: video as unknown as HTMLVideoElement, raw: video };
}

function stubCamera(stream: unknown) {
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

/** A BarcodeDetector that knows the formats the tag uses and "sees" the texts it is given, one for each look. */
function stubDetector(texts: string[]) {
  const looks: string[][] = [];
  class FakeDetector {
    static getSupportedFormats = async () => ['code_128', 'qr_code', 'ean_13'];
    constructor(public options: { formats: string[] }) {}
    detect = vi.fn(async () => {
      const next = texts.shift();
      looks.push(next ? [next] : []);
      return next ? [{ rawValue: next, format: 'qr_code' }] : [];
    });
  }
  vi.stubGlobal('BarcodeDetector', FakeDetector);
  return { FakeDetector, looks };
}

describe('FB-B2 startScan', () => {
  it('native path: opens the back camera, shows it in the video, reports each new code, and stop() lets the camera go', async () => {
    vi.useFakeTimers();
    const { track, stream, video, raw } = fakeCamera();
    const getUserMedia = stubCamera(stream);
    stubDetector(['BC-RING-00001-001', 'BC-RING-00001-001', 'BC-RING-00001-002']);

    const codes: string[] = [];
    const stop = await startScan(video, (text) => codes.push(text));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const asked = getUserMedia.mock.calls[0] as unknown as [MediaStreamConstraints];
    expect(asked[0].video).toMatchObject({ facingMode: 'environment' });
    expect(asked[0].audio).toBeFalsy();
    expect(raw.srcObject).toBe(stream);
    expect(raw.play).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    // the scanner reports what it sees; the same code twice in a row is the CameraScanner's to drop (onlyNewCodes), so here all three arrive
    expect(codes).toEqual(['BC-RING-00001-001', 'BC-RING-00001-001', 'BC-RING-00001-002']);
    expect(track.stopped).toBe(false);

    stop();
    expect(track.stopped).toBe(true);
    expect(raw.srcObject).toBeNull();
    const before = codes.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(codes).toHaveLength(before); // no look after stop
  });

  it('zxing path (no BarcodeDetector): opens the back camera through @zxing/browser, reports what it reads, and stop() stops it', async () => {
    const { video } = fakeCamera();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const codes: string[] = [];
    const stop = await startScan(video, (text) => codes.push(text));
    expect(zxing.started).toHaveLength(1);
    expect(zxing.started[0].how).toBe('constraints');
    expect(zxing.started[0].source).toMatchObject({ video: { facingMode: 'environment' } });
    zxing.emit?.('BC-RING-00001-001');
    expect(codes).toEqual(['BC-RING-00001-001']);
    stop();
    stop();
    expect(zxing.stopped).toBe(1);
  });

  it('a BarcodeDetector that never answers (it is there and does nothing) hands the same camera to @zxing/browser', async () => {
    vi.useFakeTimers();
    const { track, stream, video, raw } = fakeCamera();
    stubCamera(stream);
    const never = vi.fn(() => new Promise<never>(() => undefined));
    class Silent {
      static getSupportedFormats = async () => ['code_128', 'qr_code'];
      detect = never;
    }
    vi.stubGlobal('BarcodeDetector', Silent);

    const codes: string[] = [];
    const stop = await startScan(video, (text) => codes.push(text));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(zxing.started).toHaveLength(1));

    expect(never).toHaveBeenCalledTimes(1); // it is not asked again and again
    expect(zxing.started).toEqual([{ how: 'stream', source: stream }]);
    zxing.emit?.('BC-RING-00001-002');
    expect(codes).toEqual(['BC-RING-00001-002']);
    expect(track.stopped).toBe(false); // the camera stays open for the new reader
    stop();
    expect(zxing.stopped).toBe(1);
    expect(raw.srcObject).toBe(stream); // the picture is zxing's to clear
  });

  // FB-B fix 1: a hand-over that fails must reach the screen, which has already been given its stop function
  it('zxing path, camera refused (no BarcodeDetector, the iPhone case): rejects with the plain message and opens nothing', async () => {
    const { video } = fakeCamera();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    zxing.failWith.constraints = Object.assign(new Error('Permission denied'), {
      name: 'NotAllowedError',
    });
    const onUnavailable = vi.fn();
    const failure = await startScan(video, () => undefined, onUnavailable).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(CameraUnavailableError);
    expect((failure as Error).message).toBe(CAMERA_UNAVAILABLE);
    // a rejection is the answer of startScan itself: the screen is not told twice
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(zxing.stopped).toBe(0);
  });

  it('a hand-over that fails (the detector never answers, then @zxing/browser cannot take the stream) lets the camera go and tells the screen', async () => {
    vi.useFakeTimers();
    const { track, stream, video, raw } = fakeCamera();
    stubCamera(stream);
    class Silent {
      static getSupportedFormats = async () => ['code_128', 'qr_code'];
      detect = vi.fn(() => new Promise<never>(() => undefined));
    }
    vi.stubGlobal('BarcodeDetector', Silent);
    zxing.failWith.stream = new Error('the reader could not be loaded');

    const onUnavailable = vi.fn();
    const codes: string[] = [];
    const stop = await startScan(video, (text) => codes.push(text), onUnavailable);
    expect(onUnavailable).not.toHaveBeenCalled(); // the native reader is still being waited for
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));

    expect(zxing.started).toEqual([{ how: 'stream', source: stream }]);
    expect(track.stopped).toBe(true); // no black frame left holding the camera
    expect(raw.srcObject).toBeNull();
    expect(codes).toEqual([]);
    // the screen's Stop after the message is harmless, and the screen is not told again
    expect(() => stop()).not.toThrow();
    expect(zxing.stopped).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('a hand-over that fails after the person pressed Stop says nothing', async () => {
    vi.useFakeTimers();
    const { stream, video } = fakeCamera();
    stubCamera(stream);
    class Silent {
      static getSupportedFormats = async () => ['code_128', 'qr_code'];
      detect = vi.fn(() => new Promise<never>(() => undefined));
    }
    vi.stubGlobal('BarcodeDetector', Silent);
    zxing.failWith.stream = new Error('the reader could not be loaded');
    const onUnavailable = vi.fn();
    const stop = await startScan(video, () => undefined, onUnavailable);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('a BarcodeDetector that fails before it has ever answered hands over too; one that failed on a single frame later does not', async () => {
    vi.useFakeTimers();
    const first = fakeCamera();
    stubCamera(first.stream);
    class Broken {
      static getSupportedFormats = async () => ['code_128', 'qr_code'];
      detect = vi.fn(async () => {
        throw new Error('Barcode detection service unavailable.');
      });
    }
    vi.stubGlobal('BarcodeDetector', Broken);
    await startScan(first.video, () => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(zxing.started).toHaveLength(1));

    zxing.started.length = 0;
    const second = fakeCamera();
    stubCamera(second.stream);
    let looks = 0;
    class Flaky {
      static getSupportedFormats = async () => ['code_128', 'qr_code'];
      detect = vi.fn(async () => {
        looks += 1;
        if (looks === 2) throw new Error('one bad frame');
        return looks === 1 ? [{ rawValue: 'A' }] : [];
      });
    }
    vi.stubGlobal('BarcodeDetector', Flaky);
    const codes: string[] = [];
    await startScan(second.video, (text) => codes.push(text));
    await vi.advanceTimersByTimeAsync(1000);
    expect(codes).toEqual(['A']);
    expect(looks).toBeGreaterThan(3); // it went on looking
    expect(zxing.started).toHaveLength(0);
  });

  it('a camera the person refused rejects with the plain message, and nothing is left open', async () => {
    const { video } = fakeCamera();
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw denied;
        }),
      },
    });
    stubDetector([]);
    const failure = await startScan(video, () => undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CameraUnavailableError);
    expect((failure as Error).message).toBe(CAMERA_UNAVAILABLE);
  });

  it('no camera at all (no mediaDevices: an insecure page, a desktop with none) is manual: rejects the same way, asks for nothing', async () => {
    const { video } = fakeCamera();
    vi.stubGlobal('navigator', {});
    const failure = await startScan(video, () => undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CameraUnavailableError);
    expect((failure as Error).message).toBe(CAMERA_UNAVAILABLE);
  });

  it('says the message the brief names, with the dash', () => {
    expect(CAMERA_UNAVAILABLE).toBe('Camera not available — type the code');
  });
});

// ================================================================================================ the screens

describe('FB-B2 the billing panel and the scan screen offer the camera and keep the typed box', () => {
  it('the billing panel has a "Scan with camera" button, the typed box, and no camera open until it is pressed', async () => {
    const { default: ScanItemPanel } = await import('@/app/billing-pos/components/ScanItemPanel');
    const html = renderToStaticMarkup(
      React.createElement(ScanItemPanel, {
        onScan: () => ({ kind: 'added' as const }),
        onAddHeld: () => undefined,
      })
    );
    expect(html).toContain('Scan with camera');
    expect(html).toContain('placeholder="Enter SKU number or scan barcode..."');
    expect(html).not.toContain('<video');
  });

  it('the scan screen has a "Scan with camera" button, the typed box, and no camera open until it is pressed', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
    const { default: ScanDetailClient } =
      await import('@/app/scan-detail/components/ScanDetailClient');
    const html = renderToStaticMarkup(React.createElement(ScanDetailClient));
    expect(html).toContain('Scan with camera');
    expect(html).toContain('placeholder="Enter SKU number or barcode"');
    expect(html).not.toContain('<video');
  });
});
