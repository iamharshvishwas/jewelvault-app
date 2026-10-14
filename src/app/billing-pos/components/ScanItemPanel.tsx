'use client';
import React, { useState, useRef } from 'react';
import { ScanLine, Search } from 'lucide-react';

interface ScanItemPanelProps {
  onScan: (skuOrBarcode: string) => void;
}

export default function ScanItemPanel({ onScan }: ScanItemPanelProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onScan(trimmed);
      setValue('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className="jewel-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">Add Item by SKU / Barcode</h3>
      </div>

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

      <p className="text-xs text-muted-foreground mt-2">
        Connect a USB/Bluetooth barcode scanner — it will type directly into this field. Or use the mobile camera scan button.
      </p>
    </div>
  );
}
