'use client';
import React, { useState, useRef } from 'react';
import { Camera, ScanLine, Search } from 'lucide-react';
import CameraScanner from '@/components/CameraScanner';

/**
 * What the billing screen says about a code that was scanned or typed (spec R10): the piece was added, it was refused with a reason (not found, already sold, not for sale, already on
 * this bill), or it is Reserved or On Approval and the person must say so before it is billed (`confirm_held`).
 */
export type ScanResult =
  | { kind: 'added' }
  | { kind: 'refused'; message: string }
  | { kind: 'confirm'; message: string };

interface ScanItemPanelProps {
  onScan: (skuOrBarcode: string) => ScanResult;
  /** The person confirmed a held piece: add it, remembering that it was confirmed. */
  onAddHeld: (skuOrBarcode: string) => void;
}

export default function ScanItemPanel({ onScan, onAddHeld }: ScanItemPanelProps) {
  const [value, setValue] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ code: string; message: string } | null>(null);
  // FB-B2: the camera, and the code it read last that was added (the phone may not buzz)
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraAdded, setCameraAdded] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // a code from the keyboard, a USB scanner or the camera goes the same way
  const take = (code: string) => {
    const result = onScan(code);
    setRefused(result.kind === 'refused' ? result.message : null);
    setAsking(result.kind === 'confirm' ? { code, message: result.message } : null);
    return result;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    take(trimmed);
    setCameraAdded(null);
    setValue('');
    inputRef.current?.focus();
  };

  const closeCamera = () => {
    setCameraOpen(false);
    setCameraAdded(null);
  };

  const handleCameraCode = (text: string) => {
    const code = text.trim();
    if (!code) return;
    setCameraAdded(take(code).kind === 'added' ? code : null);
  };

  const confirmHeld = () => {
    if (!asking) return;
    onAddHeld(asking.code);
    setAsking(null);
    inputRef.current?.focus();
  };

  return (
    <div className="jewel-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">Add Item by SKU / Barcode</h3>
        <button
          type="button"
          onClick={() => (cameraOpen ? closeCamera() : setCameraOpen(true))}
          aria-pressed={cameraOpen}
          className="btn-secondary py-1.5 text-xs"
        >
          <Camera size={14} />
          Scan with camera
        </button>
      </div>

      {cameraOpen && (
        <div className="mb-3">
          <CameraScanner onCode={handleCameraCode} onStop={closeCamera} />
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-primary" />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Enter SKU number or scan barcode..."
            className="input-field pl-10 text-sm font-mono"
            autoFocus
          />
        </div>
        <button type="submit" className="btn-primary py-2 scan-button-pulse">
          <Search size={16} />
          Add
        </button>
      </form>

      {cameraAdded && (
        <p data-testid="scan-added" className="mt-2 text-xs font-semibold text-emerald-700">
          Added {cameraAdded}
        </p>
      )}

      {refused && (
        <p
          role="alert"
          data-testid="scan-refused"
          className="mt-2 text-xs font-semibold text-red-600"
        >
          {refused}
        </p>
      )}

      {asking && (
        <div
          role="alertdialog"
          aria-label="Confirm a held piece"
          data-testid="scan-confirm"
          className="mt-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        >
          <p className="font-semibold">{asking.message}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={confirmHeld} className="btn-primary py-1.5 text-xs">
              Bill it anyway
            </button>
            <button
              type="button"
              onClick={() => setAsking(null)}
              className="btn-ghost py-1.5 text-xs"
            >
              Don&apos;t add
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-2">
        Connect a USB/Bluetooth barcode scanner — it will type directly into this field. Or use the
        mobile camera scan button.
      </p>
    </div>
  );
}
