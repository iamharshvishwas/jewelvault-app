'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { Printer, Search } from 'lucide-react';
import { getDesigns } from '@/lib/designStore';
import { getSettings } from '@/lib/settingsStore';
import {
  TAG_BARCODE_OPTIONS,
  TAG_MIN_HEIGHT_MM,
  tagBarcodeLayout,
  tagBarcodeValue,
  tagShortName,
} from '@/lib/tagBarcode';
import type { Sku } from '@/lib/mockData';

// FB-B1: a real Code 128 of the piece barcode, drawn by JsBarcode into an svg that fills the width of the tag's barcode end (a scanner needs its bars as wide as the tag allows).
function Code128({ value, heightMm }: { value: string; heightMm: number }) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    try {
      JsBarcode(svg, value, TAG_BARCODE_OPTIONS);
    } catch {
      // a text Code 128 cannot carry (not ASCII): the svg stays empty, the QR and the printed text still name the piece
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    }
  }, [value]);

  return (
    <svg
      ref={ref}
      data-testid="tag-code128"
      role="img"
      aria-label={`Barcode ${value}`}
      className="tag-code128"
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      style={{ height: `${heightMm}mm` }}
    />
  );
}

function SmallQrCode({ value }: { value: string }) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    let mounted = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 3,
      color: { dark: '#000000', light: '#ffffff' },
    }).then((dataUrl) => {
      if (mounted) setSrc(dataUrl);
    });
    return () => {
      mounted = false;
    };
  }, [value]);

  if (!src) return <div className="tag-qr tag-qr-empty" aria-label={`QR code ${value}`} />;
  return <img src={src} alt={`QR code ${value}`} className="tag-qr" />;
}

function Tag({ sku }: { sku: Sku }) {
  const settings = getSettings();
  const tag = settings.tagTemplate;
  const detailLines = [
    tag.showCategory
      ? sku.subcategory
        ? `${sku.category} / ${sku.subcategory}`
        : sku.category
      : '',
    tag.showMaterial ? `${sku.material} ${sku.purity}` : sku.purity,
    tag.showGrossWeight && sku.grossWeight > 0 ? `GW ${sku.grossWeight.toFixed(3)}g` : '',
    tag.showCustomerNetWeight && sku.customerNetWeight > 0
      ? `NW ${sku.customerNetWeight.toFixed(3)}g`
      : '',
    tag.showPiroi && sku.piroi > 0 ? `Piroi ${sku.piroi.toFixed(2)}` : '',
  ].filter(Boolean);
  const tagWidth = Math.max(tag.widthMm, 58);
  const tagHeight = Math.max(tag.heightMm, TAG_MIN_HEIGHT_MM);
  // FB-B fix: the barcode end is laid out for the height of this tag (a small tag has no room for the QR)
  const barcodeEnd = tagBarcodeLayout(tagHeight, tag.barcodeHeightMm);
  const endWidth = (tagWidth - 10) / 2;

  return (
    <div
      className="print-tag-wrap bg-white text-black break-inside-avoid"
      style={{ width: `${tagWidth}mm`, height: `${tagHeight}mm`, fontSize: `${tag.fontSize}px` }}
    >
      <div className="print-tag-end print-tag-detail" style={{ width: `${endWidth}mm` }}>
        {tag.showBusinessName && (
          <div className="tag-business">{tagShortName(settings.business)}</div>
        )}
        {tag.showDesignNumber && <div className="tag-design">{sku.designNumber}</div>}
        <div className="tag-sku">{sku.skuNumber}</div>
        <div className="tag-detail-list">
          {detailLines.slice(0, 6).map((line) => (
            <span key={`${sku.id}-detail-${line}`}>{line}</span>
          ))}
        </div>
      </div>

      <div className="print-tag-neck" aria-hidden="true">
        <span />
      </div>

      <div className="print-tag-end print-tag-barcode" style={{ width: `${endWidth}mm` }}>
        <div className="tag-code-text">{sku.barcode}</div>
        <Code128 value={tagBarcodeValue(sku)} heightMm={barcodeEnd.barcodeMm} />
        {barcodeEnd.showQr && (
          <div className="tag-scan-row">
            <SmallQrCode value={tagBarcodeValue(sku)} />
          </div>
        )}
        {barcodeEnd.showNumber && <div className="tag-barcode-number">{sku.skuNumber}</div>}
      </div>
    </div>
  );
}

export default function PrintTagsClient() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const skus = useMemo(
    () =>
      getDesigns()
        .flatMap((design) => design.skus)
        .filter((sku) => sku.status !== 'Sold' && sku.status !== 'Archived'),
    [tick]
  );

  const filtered = skus.filter((sku) => {
    const haystack =
      `${sku.designNumber} ${sku.skuNumber} ${sku.barcode} ${sku.category} ${sku.material} ${sku.purity}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  const copies = Math.max(1, getSettings().tagTemplate.copiesPerSku);
  const printable = (
    selected.size > 0 ? filtered.filter((sku) => selected.has(sku.id)) : filtered
  ).flatMap((sku) => Array.from({ length: copies }, (_, index) => ({ sku, copy: index })));

  const toggle = (skuId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skuId)) next.delete(skuId);
      else next.add(skuId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Print Tags</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Select SKUs or print the filtered list. Original Net Weight is never printed.
          </p>
        </div>
        <button onClick={() => window.print()} className="btn-primary py-2">
          <Printer size={16} />
          Print {printable.length} Tag{printable.length !== 1 ? 's' : ''}
        </button>
      </div>

      <div className="jewel-card p-4 print:hidden">
        <div className="relative">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search SKU, design, barcode, category..."
            className="input-field pl-9"
          />
        </div>
        <div className="mt-3 max-h-80 overflow-y-auto scrollbar-thin divide-y divide-border">
          {filtered.map((sku) => (
            <label key={sku.id} className="flex items-center gap-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(sku.id)}
                onChange={() => toggle(sku.id)}
              />
              <span className="font-mono text-xs font-bold text-primary">{sku.skuNumber}</span>
              <span className="text-xs text-muted-foreground">
                {sku.category} · {sku.material} {sku.purity}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">{sku.status}</span>
            </label>
          ))}
        </div>
      </div>

      {/* WEB13 (QA UI-03): the grid runs over as many pages as there are tags (the print rules: the application's bars are not printed, the shell is as long as its content, a tag is never cut) */}
      <div className="print-tags-grid flex flex-wrap gap-3 print:gap-2">
        {printable.map(({ sku, copy }) => (
          <Tag key={`${sku.id}-${copy}`} sku={sku} />
        ))}
      </div>
    </div>
  );
}
