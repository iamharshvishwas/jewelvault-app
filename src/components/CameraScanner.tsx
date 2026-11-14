'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { CAMERA_UNAVAILABLE, onlyNewCodes, startScan } from '@/lib/scanner';

// FB-B2 (Siddhi #9): the camera of the scan screen and of the billing screen. It shows the picture, reads the Code 128 or QR of a tag (src/lib/scanner.ts) and hands each new code to the
// screen, which treats it exactly as a typed or USB-scanned one. A buzz (where the phone has one) says a code was read. When the camera cannot be used it says so in a line of text; the
// screen's own typed box is outside this component and works either way.

interface CameraScannerProps {
  /** A code that was read; the same code again while it stays in view does not come again. */
  onCode: (text: string) => void;
  /** The person pressed Stop: the screen takes the scanner away, which lets the camera go. */
  onStop: () => void;
}

export default function CameraScanner({ onCode, onStop }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latest = useRef(onCode);
  const [unavailable, setUnavailable] = useState(false);

  // the screen's handler changes with its state (the bill so far): the scan always calls the newest
  useEffect(() => {
    latest.current = onCode;
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    const report = onlyNewCodes((text) => {
      navigator.vibrate?.(60);
      latest.current(text);
    });
    // started a moment later: a screen that is left at once (or React's test remount in development) never opens the camera at all
    const timer = setTimeout(() => {
      startScan(video, report)
        .then((stopScan) => {
          if (cancelled) stopScan();
          else stop = stopScan;
        })
        .catch(() => {
          if (!cancelled) setUnavailable(true);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop?.();
    };
  }, []);

  if (unavailable) {
    return (
      <div
        role="alert"
        data-testid="camera-unavailable"
        className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span className="flex-1">{CAMERA_UNAVAILABLE}</span>
        <button type="button" onClick={onStop} className="font-semibold underline">
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="camera-scanner">
      <div className="relative w-full max-w-md mx-auto rounded-xl overflow-hidden bg-black aspect-video">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="relative w-56 h-36 max-w-[70%] max-h-[70%]">
            <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary rounded-tl-sm" />
            <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-primary rounded-tr-sm" />
            <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-primary rounded-bl-sm" />
            <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary rounded-br-sm" />
            <span className="absolute left-1 right-1 h-0.5 bg-primary/70 animate-scan-line" />
          </div>
        </div>
        <p className="absolute bottom-2 left-0 right-0 text-center text-xs text-white/80">
          Hold the tag&apos;s barcode or QR inside the frame
        </p>
      </div>
      <div className="flex justify-center">
        <button type="button" onClick={onStop} className="btn-secondary py-1.5 text-sm">
          Stop
        </button>
      </div>
    </div>
  );
}
