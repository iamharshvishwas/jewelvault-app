'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Printer } from 'lucide-react';
import PdfActions from '@/components/pdf/PdfActions';
import { BUSINESS_NAME } from '@/lib/businessConfig';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { getDesigns } from '@/lib/designStore';
import { imagesSettled } from '@/lib/imageWait';
import { cataloguePdfDefinition } from '@/lib/pdf/cataloguePdf';
import { catalogueFileName } from '@/lib/pdf/fileName';
import type { PdfJobDeps } from '@/lib/pdf/pdfJob';
import { fetchPhotoDataUrls } from '@/lib/pdf/photoFetch';
import { photoUrl } from '@/lib/photos';
import { getSettings } from '@/lib/settingsStore';
import { catalogueRows, dayShown, grossShown, type CatalogueRow } from '@/lib/stockCatalogue';

// FB-D2 (Siddhi #6): the ready-stock catalogue. The shop chooses the categories (none chosen: every category that has stock), the page shows each design that has a piece In Stock with its first
// photo, design number, name, purity, the range of the gross weights of the pieces in stock and how many there are, and "Print" gives the browser's print of that sheet (the rules are in
// src/styles/tailwind.css under `.print-catalogue-sheet`; the same print shell as the estimate, WEB13). The rows are `catalogueRows` (src/lib/stockCatalogue.ts): never the owner's original
// weight, never a price. The screen is drawn again when the designs or their pieces change in memory.
// Wave 2 fix 2: a shop with hundreds of designs must not fetch hundreds of pictures the moment the screen opens, so on the screen the photos are the 320 px thumbnails, loaded lazily and decoded
// off the main thread. "Print" first switches the sheet to the full pictures (1000 px: a thumbnail is soft on paper) loaded eagerly, waits until every picture has loaded (or failed, or 15 seconds
// have gone by: a broken photo never stops a paper) and only then asks the browser to print; `afterprint` puts the screen back as it was.
// PDF-6: Download PDF and Share make the same sheet as a PDF file in the browser (src/lib/pdf/cataloguePdf.ts; the buttons are src/components/pdf/PdfActions.tsx), with the thumbnails the page
// fetches itself (src/lib/pdf/photoFetch.ts): the busy words count them, and Stop ends it. With nothing in stock the buttons cannot be pressed.

const DESIGNS = ['users', 'categories', 'subcategories', 'designs', 'skus', 'settings'] as const;

/** The longest the print waits for the pictures (a photo that never arrives is a paper without that photo, not a button that does nothing). */
const PICTURES_WAIT_MS = 15_000;

function Card({ row, printing }: { row: CatalogueRow; printing: boolean }) {
  return (
    <article
      data-testid="catalogue-card"
      className="print-catalogue-card rounded-xl border border-border bg-white p-3 text-foreground"
    >
      <div className="print-catalogue-photo aspect-square w-full rounded-lg bg-muted">
        {row.photoId ? (
          // eslint-disable-next-line @next/next/no-img-element -- the API's own picture, served as stored (the build has no image optimiser); the thumbnail, lazily, on the screen; the full picture, eagerly, for paper
          <img
            src={photoUrl(row.photoId, printing ? 'full' : 'thumb')}
            alt={`${row.designNumber} ${row.designName}`.trim()}
            loading={printing ? 'eager' : 'lazy'}
            decoding="async"
            className="h-full w-full rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
            No photo
          </div>
        )}
      </div>
      <p className="mt-2 font-mono text-sm font-bold text-primary">{row.designNumber}</p>
      {row.designName && <p className="text-sm font-semibold">{row.designName}</p>}
      <p className="text-xs text-muted-foreground">{row.purity}</p>
      <p className="mt-1 text-xs">Gross {grossShown(row)}</p>
      <p className="text-xs">
        {row.inStock} {row.inStock === 1 ? 'piece' : 'pieces'} in stock
      </p>
    </article>
  );
}

export default function StockCatalogueClient() {
  useRowCacheVersion(...DESIGNS);
  const today = useBusinessToday();
  const [chosen, setChosen] = useState<string[]>([]);
  // the sheet is being got ready for paper: full pictures, loaded eagerly (until `afterprint`)
  const [printing, setPrinting] = useState(false);
  const sheet = useRef<HTMLElement>(null);
  const preparing = useRef(false);
  const alive = useRef(true);
  const designs = getDesigns();
  const { business } = getSettings();
  const shopName = business.legalName.trim() || BUSINESS_NAME;

  // the categories that have a design with a piece In Stock: those are the ones worth choosing
  const offered = useMemo(
    () =>
      catalogueRows(designs, [...new Set(designs.map((design) => design.category))])
        .map((row) => row.category)
        .filter((category, i, all) => all.indexOf(category) === i),
    [designs]
  );
  // none chosen is every category (a choice that left the paper empty would be of no use)
  const shown =
    chosen.length === 0 ? offered : offered.filter((category) => chosen.includes(category));
  const rows = useMemo(() => catalogueRows(designs, shown), [designs, shown]);
  const groups = shown
    .map((category) => ({ category, rows: rows.filter((row) => row.category === category) }))
    .filter((group) => group.rows.length > 0);

  // PDF-6: the PDF of the sheet below: the same groups, the same shop name and the same day as the screen shows. The photos are fetched first (the busy words count them; Stop ends the fetch),
  // then pdfmake and its fonts, at the first tap and never with the page; the definition is made afresh at every tap (pdfmake writes into the one it lays out).
  const makePdf: PdfJobDeps['make'] = async (report, signal) => {
    const photoIds = groups.flatMap((group) =>
      group.rows.flatMap((row) => (row.photoId === null ? [] : [row.photoId]))
    );
    const { photos } = await fetchPhotoDataUrls(photoIds, { signal, onProgress: report });
    const { makePdfBlob } = await import('@/lib/pdf/engine');
    // stopped while pdfmake was on its way: nothing is drawn
    if (signal.aborted) throw new DOMException('The PDF was stopped.', 'AbortError');
    const businessDate = today || null;
    const definition = cataloguePdfDefinition({ shopName, businessDate, groups, photos });
    return {
      blob: await makePdfBlob(definition),
      fileName: catalogueFileName(chosen, businessDate),
    };
  };

  useEffect(() => {
    alive.current = true;
    const after = () => setPrinting(false);
    window.addEventListener('afterprint', after);
    return () => {
      alive.current = false;
      window.removeEventListener('afterprint', after);
    };
  }, []);

  const handlePrint = async () => {
    if (preparing.current) return;
    preparing.current = true;
    try {
      flushSync(() => setPrinting(true));
      await imagesSettled(sheet.current, PICTURES_WAIT_MS);
    } finally {
      preparing.current = false;
    }
    // a person who has left the screen in the meantime is not printing it
    if (alive.current) window.print();
  };

  const toggle = (category: string) =>
    setChosen((before) =>
      before.includes(category) ? before.filter((name) => name !== category) : [...before, category]
    );

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Stock Catalogue</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            The designs in stock now, with a photo, for a PDF to send or print. No prices.
          </p>
        </div>
        {/* PDF-6: the buttons wrap on a phone, and a failure's sentence goes on a line of its own under them */}
        <div className="flex flex-wrap items-center gap-2">
          {/* one per choice of categories: a PDF being made, or a share waiting for its second tap, never moves over to another choice */}
          <PdfActions
            key={chosen.join('\n')}
            make={makePdf}
            shareTitle="Stock Catalogue"
            testIdPrefix="catalogue-pdf"
            disabled={groups.length === 0}
            disabledReason="Nothing in stock to put in a PDF."
          />
          <button
            type="button"
            data-testid="print-catalogue"
            onClick={() => void handlePrint()}
            className="btn-secondary py-2"
          >
            <Printer size={15} />
            Print
          </button>
        </div>
      </div>

      <div className="jewel-card p-4 print:hidden">
        <p className="text-xs font-semibold text-foreground mb-2">Categories</p>
        <div className="flex flex-wrap gap-2">
          {offered.map((category) => {
            const on = chosen.includes(category);
            return (
              <button
                key={category}
                type="button"
                data-testid="catalogue-category"
                aria-pressed={on}
                onClick={() => toggle(category)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                  on
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground'
                }`}
              >
                {category}
              </button>
            );
          })}
          {chosen.length > 0 && (
            <button type="button" className="btn-ghost text-xs" onClick={() => setChosen([])}>
              Clear
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {chosen.length === 0
            ? 'No category chosen: every category with stock is shown.'
            : `${chosen.length} chosen.`}
        </p>
      </div>

      <section ref={sheet} className="print-catalogue-sheet space-y-5 text-foreground">
        <div className="print-catalogue-head border-b border-border pb-3">
          <h2 data-testid="catalogue-shop-name" className="text-xl font-bold">
            {shopName}
          </h2>
          <p className="text-sm text-muted-foreground">
            Ready stock{today ? ` as of ${dayShown(today)}` : ''}
          </p>
        </div>
        {groups.length === 0 ? (
          <p data-testid="catalogue-empty" className="py-6 text-sm text-muted-foreground">
            No design with a piece in stock{chosen.length > 0 ? ' in these categories' : ''}.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.category} className="print-catalogue-category">
              <h3 className="text-base font-bold mb-2">{group.category}</h3>
              <div className="print-catalogue-grid grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {group.rows.map((row) => (
                  <Card key={row.designNumber} row={row} printing={printing} />
                ))}
              </div>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
