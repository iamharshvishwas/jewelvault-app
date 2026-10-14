'use client';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { type Sku, type Design } from '@/lib/mockData';
import { getDesigns as getDesignsFromStore } from '@/lib/designStore';
import StatusBadge from '@/components/ui/StatusBadge';
import MaterialBadge from '@/components/ui/MaterialBadge';
import AppImage from '@/components/ui/AppImage';
import {
  ScanLine,
  Search,
  Camera,
  X,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  ChevronRight,
  MapPin,
  Scale,
  Gem,
  Tag,
  ReceiptText,
  ArrowLeftRight,
  RefreshCw,
  Info,
  Package,
  Hash,
} from 'lucide-react';

// Build a flat lookup map: barcode/skuNumber → { sku, design }
type SkuRecord = { sku: Sku; design: Design };

function buildLookup(): Map<string, SkuRecord> {
  const map = new Map<string, SkuRecord>();
  for (const design of getDesignsFromStore()) {
    for (const sku of design.skus) {
      map.set(sku.barcode.toLowerCase(), { sku, design });
      map.set(sku.skuNumber.toLowerCase(), { sku, design });
    }
  }
  return map;
}

// SKU_LOOKUP is rebuilt dynamically on each scan to include newly added designs

type ScanState = 'idle' | 'camera' | 'found' | 'not-found' | 'already-sold';

export default function ScanDetailClient() {
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [manualInput, setManualInput] = useState('');
  const [result, setResult] = useState<SkuRecord | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanHistory, setScanHistory] = useState<SkuRecord[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const startCamera = async () => {
    setCameraError(null);
    setScanState('camera');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCameraActive(true);
    } catch {
      setCameraError('Camera access denied or not available. Use manual input below.');
      setScanState('idle');
    }
  };

  const handleManualSearch = (value?: string) => {
    const query = (value ?? manualInput).trim().toLowerCase();
    if (!query) return;
    stopCamera();
        const found = buildLookup().get(query);
    if (!found) {
      setScanState('not-found');
      setResult(null);
      return;
    }
    if (found.sku.status === 'Sold') {
      setScanState('already-sold');
      setResult(found);
    } else {
      setScanState('found');
      setResult(found);
      setScanHistory((prev) => {
        const exists = prev.find((r) => r.sku.id === found.sku.id);
        if (exists) return prev;
        return [found, ...prev].slice(0, 5);
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleManualSearch();
  };

  // Simulate a barcode scanner USB/Bluetooth input (rapid keystrokes ending in Enter)
  // The manual input field handles this naturally.

  const handleReset = () => {
    setScanState('idle');
    setResult(null);
    setManualInput('');
    stopCamera();
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const handleSimulateScan = (barcode: string) => {
    setManualInput(barcode);
    handleManualSearch(barcode);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Scan Article</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Scan barcode / QR code or enter SKU manually to retrieve article details
          </p>
        </div>
        {(scanState === 'found' || scanState === 'already-sold' || scanState === 'not-found') && (
          <button onClick={handleReset} className="btn-secondary py-2 gap-1.5">
            <RefreshCw size={14} />
            Scan Again
          </button>
        )}
      </div>

      {/* ── SCAN INPUT PANEL ─────────────────────────────────────────── */}
      {(scanState === 'idle' || scanState === 'camera' || scanState === 'not-found') && (
        <div className="jewel-card p-5 space-y-4">
          {/* Camera Viewfinder */}
          {scanState === 'camera' && (
            <div className="relative rounded-xl overflow-hidden bg-black aspect-video">
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
                autoPlay
              />
              {/* Scan overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="relative w-56 h-36">
                  {/* Corner brackets */}
                  <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary rounded-tl-sm" />
                  <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-primary rounded-tr-sm" />
                  <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-primary rounded-bl-sm" />
                  <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary rounded-br-sm" />
                  {/* Scan line animation */}
                  <span className="absolute left-1 right-1 h-0.5 bg-primary/70 animate-scan-line" />
                </div>
              </div>
              {/* Close camera */}
              <button
                onClick={() => { stopCamera(); setScanState('idle'); }}
                className="absolute top-3 right-3 bg-black/60 text-white rounded-full p-1.5 hover:bg-black/80 transition-colors"
              >
                <X size={16} />
              </button>
              <p className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/80">
                Align barcode within the frame
              </p>
            </div>
          )}

          {cameraError && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {cameraError}
            </div>
          )}

          {/* Camera Button */}
          {scanState !== 'camera' && (
            <button
              onClick={startCamera}
              className="w-full flex items-center justify-center gap-3 py-5 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 hover:bg-primary/10 hover:border-primary/60 transition-all group"
            >
              <span className="w-12 h-12 rounded-full bg-primary/10 group-hover:bg-primary/20 flex items-center justify-center transition-colors">
                <Camera size={22} className="text-primary" />
              </span>
              <div className="text-left">
                <p className="font-semibold text-foreground text-sm">Open Camera</p>
                <p className="text-xs text-muted-foreground">Scan barcode or QR code</p>
              </div>
            </button>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground font-medium">or enter manually</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* Manual Input */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <ScanLine size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter SKU number or barcode (e.g. SET-00572-001)"
                className="w-full pl-9 pr-4 py-2.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary font-mono"
                autoFocus
              />
            </div>
            <button
              onClick={() => handleManualSearch()}
              className="btn-primary px-4 py-2.5"
            >
              <Search size={16} />
              <span className="hidden sm:inline">Search</span>
            </button>
          </div>

          {/* Not found state */}
          {scanState === 'not-found' && (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
              <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-700">SKU Not Found</p>
                <p className="text-xs text-red-600 mt-0.5">
                  No article matches <span className="font-mono font-bold">{manualInput}</span>. Check the barcode or SKU number and try again.
                </p>
              </div>
            </div>
          )}

          {/* Quick demo scans */}
          <div className="pt-1">
            <p className="text-xs text-muted-foreground font-medium mb-2">Quick demo scans:</p>
            <div className="flex flex-wrap gap-2">
              {[
                { label: 'SET-00572-001', barcode: 'JV-SET-00572-001' },
                { label: 'SET-00572-003 (Sold)', barcode: 'JV-SET-00572-003' },
                { label: 'RING-00821-001', barcode: 'JV-RING-00821-001' },
                { label: 'ER-00341-002 (Approval)', barcode: 'JV-ER-00341-002' },
              ].map((demo) => (
                <button
                  key={demo.barcode}
                  onClick={() => handleSimulateScan(demo.barcode)}
                  className="text-xs px-3 py-1.5 rounded-full border border-border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors font-mono"
                >
                  {demo.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── ALREADY SOLD WARNING ─────────────────────────────────────── */}
      {scanState === 'already-sold' && result && (
        <AlreadySoldCard record={result} onReset={handleReset} />
      )}

      {/* ── SKU DETAIL RESULT ────────────────────────────────────────── */}
      {scanState === 'found' && result && (
        <SkuDetailCard record={result} onReset={handleReset} />
      )}

      {/* ── RECENT SCANS ─────────────────────────────────────────────── */}
      {scanHistory.length > 0 && scanState === 'idle' && (
        <div className="jewel-card p-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Scans</p>
          <div className="space-y-2">
            {scanHistory.map((rec) => (
              <button
                key={rec.sku.id}
                onClick={() => { setResult(rec); setScanState('found'); }}
                className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors text-left"
              >
                <div className="w-9 h-9 rounded-lg overflow-hidden shrink-0 bg-muted">
                  <AppImage
                    src={rec.design.primaryImage}
                    alt={rec.design.designName}
                    width={36}
                    height={36}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground font-mono">{rec.sku.skuNumber}</p>
                  <p className="text-xs text-muted-foreground truncate">{rec.design.designName} · {rec.sku.category}</p>
                </div>
                <StatusBadge status={rec.sku.status} />
                <ChevronRight size={14} className="text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Already Sold Card ──────────────────────────────────────────────────────────
function AlreadySoldCard({ record, onReset }: { record: SkuRecord; onReset: () => void }) {
  const { sku, design } = record;
  return (
    <div className="space-y-4">
      {/* Warning Banner */}
      <div className="flex items-start gap-4 p-4 bg-red-50 border-2 border-red-300 rounded-xl">
        <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
          <AlertTriangle size={20} className="text-red-600" />
        </div>
        <div>
          <p className="font-bold text-red-700 text-base">This SKU is Already Sold</p>
          <p className="text-sm text-red-600 mt-0.5">
            <span className="font-mono font-bold">{sku.skuNumber}</span> has been sold and cannot be billed again.
          </p>
        </div>
      </div>

      {/* SKU Info (limited) */}
      <div className="jewel-card p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="w-16 h-16 rounded-xl overflow-hidden bg-muted shrink-0">
            <AppImage
              src={design.primaryImage}
              alt={design.designName}
              width={64}
              height={64}
              className="w-full h-full object-cover"
            />
          </div>
          <div>
            <p className="font-bold text-foreground font-mono text-lg">{sku.skuNumber}</p>
            <p className="text-sm text-muted-foreground">{design.designName}</p>
            <div className="flex items-center gap-2 mt-1">
              <StatusBadge status={sku.status} />
              <MaterialBadge material={sku.material} purity={sku.purity} />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 p-3 bg-muted/40 rounded-lg text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Design</p>
            <p className="font-semibold font-mono">{sku.designNumber}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Category</p>
            <p className="font-semibold">{sku.category}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Location</p>
            <p className="font-semibold">{sku.location}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Barcode</p>
            <p className="font-semibold font-mono text-xs">{sku.barcode}</p>
          </div>
        </div>
        <div className="mt-4 p-3 bg-amber-50 border border-amber-100 rounded-lg flex items-start gap-2">
          <Info size={14} className="text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-700">
            Sale details are visible to authorised users only. Contact Admin to view invoice and customer information.
          </p>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onReset} className="btn-secondary py-2 flex-1 justify-center">
            <RefreshCw size={14} />
            Scan Another
          </button>
          <Link href="/design-detail" className="btn-ghost py-2 flex-1 justify-center text-sm">
            <Package size={14} />
            View Design
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── SKU Detail Card ────────────────────────────────────────────────────────────
function SkuDetailCard({ record, onReset }: { record: SkuRecord; onReset: () => void }) {
  const { sku, design } = record;

  const isActionable = sku.status === 'In Stock';
  const isReserved = sku.status === 'Reserved';
  const isOnApproval = sku.status === 'On Approval';

  const weightRows = [
    { label: 'Gross Weight', value: sku.grossWeight > 0 ? `${sku.grossWeight.toFixed(3)} g` : null },
    { label: 'Customer Net Weight', value: sku.customerNetWeight > 0 ? `${sku.customerNetWeight.toFixed(3)} g` : null },
    { label: 'Piroi', value: sku.piroi > 0 ? `₹${sku.piroi.toLocaleString('en-IN')}` : null },
  ].filter((r) => r.value !== null);

  const stoneRows = [
    { label: 'Stones', value: sku.stones > 0 ? `${sku.stones} pcs` : null },
    { label: 'Stone Weight', value: sku.stoneWeight > 0 ? `${sku.stoneWeight.toFixed(3)} g` : null },
    { label: 'Kundan', value: sku.kundan > 0 ? `${sku.kundan} pcs` : null },
    { label: 'Kundan Weight', value: sku.kundanWeight > 0 ? `${sku.kundanWeight.toFixed(3)} g` : null },
  ].filter((r) => r.value !== null);

  return (
    <div className="space-y-4">
      {/* Status Banner */}
      {!isActionable && (
        <div className={`flex items-center gap-3 p-3 rounded-xl border ${
          isReserved ? 'bg-amber-50 border-amber-200' : isOnApproval ?'bg-blue-50 border-blue-200': 'bg-muted border-border'
        }`}>
          <AlertTriangle size={16} className={isReserved ? 'text-amber-600' : isOnApproval ? 'text-blue-600' : 'text-muted-foreground'} />
          <p className={`text-sm font-medium ${isReserved ? 'text-amber-700' : isOnApproval ? 'text-blue-700' : 'text-muted-foreground'}`}>
            {isReserved && 'This article is currently Reserved and may not be available for sale.'}
            {isOnApproval && 'This article is currently On Approval and cannot be sold until returned.'}
            {!isReserved && !isOnApproval && `Status: ${sku.status} — confirm availability before proceeding.`}
          </p>
        </div>
      )}

      {/* Main Card */}
      <div className="jewel-card overflow-hidden">
        {/* Top: Image + Identity */}
        <div className="flex gap-4 p-5 border-b border-border">
          <div className="w-20 h-20 rounded-xl overflow-hidden bg-muted shrink-0">
            <AppImage
              src={design.primaryImage}
              alt={design.designName}
              width={80}
              height={80}
              className="w-full h-full object-cover"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div>
                <p className="text-xl font-bold text-foreground font-mono leading-tight">{sku.skuNumber}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{design.designName || design.designNumber}</p>
              </div>
              <StatusBadge status={sku.status} />
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <MaterialBadge material={sku.material} purity={sku.purity} />
              <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">{sku.category}</span>
              {sku.subcategory && (
                <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">{sku.subcategory}</span>
              )}
            </div>
          </div>
        </div>

        {/* Details Grid */}
        <div className="p-5 space-y-4">
          {/* Design & SKU IDs */}
          <div className="grid grid-cols-2 gap-3">
            <DetailCell icon={<Hash size={13} />} label="Design Number" value={sku.designNumber} mono />
            <DetailCell icon={<Tag size={13} />} label="SKU Number" value={sku.skuNumber} mono />
          </div>

          {/* Weights */}
          {weightRows.length > 0 && (
            <div>
              <SectionLabel icon={<Scale size={13} />} label="Weight Details" />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
                {weightRows.map((r) => (
                  <DetailCell key={r.label} label={r.label} value={r.value!} />
                ))}
              </div>
            </div>
          )}

          {/* Stones & Kundan */}
          {stoneRows.length > 0 && (
            <div>
              <SectionLabel icon={<Gem size={13} />} label="Stone & Kundan" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
                {stoneRows.map((r) => (
                  <DetailCell key={r.label} label={r.label} value={r.value!} />
                ))}
              </div>
            </div>
          )}

          {/* Labour & Selling */}
          <div className="grid grid-cols-2 gap-3">
            {sku.labour > 0 && (
              <DetailCell label="Labour Rate" value={`₹${sku.labour.toLocaleString('en-IN')}/${sku.sellingMethod === 'By Weight' ? 'g' : 'pc'}`} />
            )}
            <DetailCell label="Selling Method" value={sku.sellingMethod} />
          </div>

          {/* Location */}
          <div className="flex items-center gap-2 p-3 bg-muted/40 rounded-lg">
            <MapPin size={14} className="text-primary shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Current Location</p>
              <p className="text-sm font-semibold text-foreground">{sku.location}</p>
            </div>
          </div>

          {/* Barcode */}
          <div className="flex items-center gap-2 p-3 bg-muted/40 rounded-lg">
            <ScanLine size={14} className="text-muted-foreground shrink-0" />
            <div>
              <p className="text-xs text-muted-foreground">Barcode / SKU ID</p>
              <p className="text-sm font-mono font-semibold text-foreground">{sku.barcode}</p>
            </div>
          </div>

          {/* Notes */}
          {sku.notes && (
            <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg">
              <p className="text-xs font-semibold text-amber-700 mb-1">Notes</p>
              <p className="text-xs text-amber-800">{sku.notes}</p>
            </div>
          )}

          {/* Inventory Confirmation */}
          <div className={`flex items-center gap-3 p-3 rounded-xl border ${
            isActionable
              ? 'bg-emerald-50 border-emerald-200' :'bg-muted/40 border-border'
          }`}>
            {isActionable ? (
              <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle size={18} className="text-muted-foreground shrink-0" />
            )}
            <div>
              <p className={`text-sm font-semibold ${isActionable ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                {isActionable ? 'Available in Inventory' : `Not Available for Sale (${sku.status})`}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isActionable
                  ? 'This article is in stock and ready for billing or transfer.'
                  : 'Confirm status with inventory staff before proceeding.'}
              </p>
            </div>
          </div>
        </div>

        {/* Action Footer */}
        <div className="px-5 pb-5 pt-1 border-t border-border">
          <p className="text-xs text-muted-foreground font-medium mb-3 mt-3">Actions</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <Link
              href="/billing-pos"
              className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-sm font-semibold transition-colors ${
                isActionable
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed pointer-events-none opacity-60'
              }`}
            >
              <ReceiptText size={15} />
              Create Invoice
            </Link>
            <Link
              href="/billing-pos"
              className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-sm font-semibold border transition-colors ${
                isActionable
                  ? 'border-border hover:bg-muted text-foreground'
                  : 'border-border bg-muted/40 text-muted-foreground cursor-not-allowed pointer-events-none opacity-60'
              }`}
            >
              <ArrowLeftRight size={15} />
              Transfer
            </Link>
            <Link
              href="/design-detail"
              className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-sm font-semibold border border-border hover:bg-muted text-foreground transition-colors col-span-2 sm:col-span-1"
            >
              <Package size={15} />
              View Design
            </Link>
          </div>
          <button
            onClick={onReset}
            className="w-full mt-2 btn-ghost py-2 text-sm text-muted-foreground justify-center"
          >
            <RefreshCw size={13} />
            Scan Another Article
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────────
function DetailCell({
  label,
  value,
  icon,
  mono = false,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="bg-muted/40 rounded-lg p-3">
      <div className="flex items-center gap-1 mb-1">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
      </div>
      <p className={`text-sm font-semibold text-foreground ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
    </div>
  );
}
