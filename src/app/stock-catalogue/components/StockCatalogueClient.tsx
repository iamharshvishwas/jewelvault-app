'use client';

import React, { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { BUSINESS_NAME } from '@/lib/businessConfig';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { getDesigns } from '@/lib/designStore';
import { mgShown } from '@/lib/ledgerView';
import { photoUrl } from '@/lib/photos';
import { getSettings } from '@/lib/settingsStore';
import { catalogueRows, type CatalogueRow } from '@/lib/stockCatalogue';

// FB-D2 (Siddhi #6): the ready-stock catalogue. The shop chooses the categories (none chosen: every category that has stock), the page shows each design that has a piece In Stock with its first
// photo, design number, name, purity, the range of the gross weights of the pieces in stock and how many there are, and "Print / Save PDF" gives the browser's print of that sheet (the rules
// are in src/styles/tailwind.css under `.print-catalogue-sheet`; the same print shell as the estimate, WEB13). The rows are `catalogueRows` (src/lib/stockCatalogue.ts): never the owner's original
// weight, never a price. The screen is drawn again when the designs or their pieces change in memory.

const DESIGNS = ['users', 'categories', 'subcategories', 'designs', 'skus', 'settings'] as const;

const day = (businessDate: string) =>
  new Date(`${businessDate}T12:00:00.000Z`).toLocaleDateString('en-IN');

function grossShown(row: CatalogueRow): string {
  return row.grossMinMg === row.grossMaxMg
    ? mgShown(row.grossMinMg)
    : `${mgShown(row.grossMinMg).replace(/ g$/, '')} - ${mgShown(row.grossMaxMg)}`;
}

function Card({ row }: { row: CatalogueRow }) {
  return (
    <article
      data-testid="catalogue-card"
      className="print-catalogue-card rounded-xl border border-border bg-white p-3 text-foreground"
    >
      <div className="print-catalogue-photo aspect-square w-full rounded-lg bg-muted">
        {row.photoId ? (
          // eslint-disable-next-line @next/next/no-img-element -- the API's own picture, served as stored (the build has no image optimiser); eager, because a paper must not wait for a scroll
          <img
            src={photoUrl(row.photoId, 'thumb')}
            alt={`${row.designNumber} ${row.designName}`.trim()}
            loading="eager"
            decoding="sync"
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
        <button
          type="button"
          data-testid="print-catalogue"
          onClick={() => window.print()}
          className="btn-primary py-2"
        >
          <Printer size={15} />
          Print / Save PDF
        </button>
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

      <section className="print-catalogue-sheet space-y-5 text-foreground">
        <div className="print-catalogue-head border-b border-border pb-3">
          <h2 data-testid="catalogue-shop-name" className="text-xl font-bold">
            {shopName}
          </h2>
          <p className="text-sm text-muted-foreground">
            Ready stock{today ? ` as of ${day(today)}` : ''}
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
                  <Card key={row.designNumber} row={row} />
                ))}
              </div>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
