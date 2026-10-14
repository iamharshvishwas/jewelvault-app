'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Grid, List, Printer, Search, Share2, ShoppingBag, X } from 'lucide-react';
import AppImage from '@/components/ui/AppImage';
import AppLogo from '@/components/ui/AppLogo';
import MaterialBadge from '@/components/ui/MaterialBadge';
import { getCategories } from '@/lib/catalogStore';
import { getDesigns } from '@/lib/designStore';
import { getSettings } from '@/lib/settingsStore';
import { getSession } from '@/lib/authStore';
import type { Design, Sku } from '@/lib/mockData';

type CatalogueDesign = Design & {
  availableSkus: Sku[];
  minWeight: number;
  maxWeight: number;
};

function customerSafeDesigns(): CatalogueDesign[] {
  return getDesigns()
    .map((design) => {
      const availableSkus = design.skus.filter((sku) => sku.status === 'In Stock');
      const weights = availableSkus.map((sku) => sku.customerNetWeight).filter((weight) => weight > 0);
      return {
        ...design,
        availableSkus,
        minWeight: weights.length ? Math.min(...weights) : 0,
        maxWeight: weights.length ? Math.max(...weights) : 0,
      };
    })
    .filter((design) => design.availableSkus.length > 0);
}

function weightLabel(design: CatalogueDesign) {
  if (design.minWeight <= 0) return 'Weight on request';
  if (design.minWeight === design.maxWeight) return `${design.minWeight.toFixed(3)} g`;
  return `${design.minWeight.toFixed(3)}-${design.maxWeight.toFixed(3)} g`;
}

export default function CatalogueClient({ customerOnly = false }: { customerOnly?: boolean }) {
  const [designs, setDesigns] = useState<CatalogueDesign[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [material, setMaterial] = useState('All');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [copied, setCopied] = useState('');
  const settings = getSettings();
  const session = customerOnly ? null : getSession();

  useEffect(() => {
    const sync = () => setDesigns(customerSafeDesigns());
    sync();
    window.addEventListener('focus', sync);
    const interval = window.setInterval(sync, 1000);
    return () => {
      window.removeEventListener('focus', sync);
      window.clearInterval(interval);
    };
  }, []);

  const categories = useMemo(() => ['All', ...getCategories()], []);
  const materials = useMemo(() => ['All', ...Array.from(new Set(designs.map((design) => design.material)))], [designs]);

  const filtered = designs.filter((design) => {
    const search = `${design.designNumber} ${design.designName} ${design.category} ${design.subcategory} ${design.material} ${design.purity} ${design.tags.join(' ')}`.toLowerCase();
    return (
      search.includes(query.toLowerCase()) &&
      (category === 'All' || design.category === category) &&
      (material === 'All' || design.material === material)
    );
  });

  const copyInquiry = async (design: CatalogueDesign) => {
    const text = `${settings.business.displayName}: ${design.designNumber} - ${design.designName || design.category}, ${design.material} ${design.purity}, ${weightLabel(design)}, ${design.availableSkus.length} piece(s) available.`;
    await navigator.clipboard.writeText(text);
    setCopied(design.id);
    window.setTimeout(() => setCopied(''), 1800);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 bg-card/95 backdrop-blur border-b border-border print:static">
        <div className="max-w-screen-2xl mx-auto px-4 lg:px-8 py-3 flex items-center justify-between gap-3">
          <Link href={customerOnly ? '/customer-catalogue' : '/'} className="flex items-center gap-3 min-w-0 hover:opacity-80 transition-opacity">
            <AppLogo size={38} />
            <div className="min-w-0">
              <h1 className="font-bold text-lg leading-tight truncate">{settings.business.legalName}</h1>
              <p className="text-xs text-muted-foreground truncate">{settings.business.location} · {customerOnly ? 'Catalogue' : 'Customer Catalogue Preview'}</p>
            </div>
          </Link>
          <div className="flex items-center gap-2 print:hidden">
            <button onClick={() => window.print()} className="btn-secondary py-2">
              <Printer size={15} />
              Print
            </button>
            {!customerOnly && session?.role === 'Admin' && (
              <Link href="/billing-pos" className="btn-primary py-2">
                <ShoppingBag size={15} />
                Create Estimate
              </Link>
            )}
          </div>
        </div>
      </header>

      <section className="max-w-screen-2xl mx-auto px-4 lg:px-8 py-5 space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 print:hidden">
          <div>
            <h2 className="text-2xl font-bold">Catalogue</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {filtered.length} design{filtered.length !== 1 ? 's' : ''} available
            </p>
          </div>
          <div className="grid sm:grid-cols-[minmax(260px,1fr)_180px_150px_auto] gap-2 w-full xl:w-auto xl:min-w-[760px]">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} className="input-field pl-9" placeholder="Search design, category, material..." />
              {query && (
                <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X size={15} />
                </button>
              )}
            </div>
            <select value={category} onChange={(event) => setCategory(event.target.value)} className="input-field">
              {categories.map((item) => <option key={item}>{item}</option>)}
            </select>
            <select value={material} onChange={(event) => setMaterial(event.target.value)} className="input-field">
              {materials.map((item) => <option key={item}>{item}</option>)}
            </select>
            <div className="flex items-center bg-muted rounded-sm p-1">
              <button onClick={() => setView('grid')} className={`p-2 rounded-sm ${view === 'grid' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground'}`} aria-label="Grid view">
                <Grid size={16} />
              </button>
              <button onClick={() => setView('list')} className={`p-2 rounded-sm ${view === 'list' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground'}`} aria-label="List view">
                <List size={16} />
              </button>
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="jewel-card p-10 text-center">
            <h3 className="text-lg font-bold">No catalogue designs available</h3>
            <p className="text-sm text-muted-foreground mt-1">Add designs with In Stock SKUs to show them here.</p>
          </div>
        ) : view === 'grid' ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
            {filtered.map((design) => (
              <CatalogueCard key={design.id} design={design} copied={copied === design.id} onCopy={() => copyInquiry(design)} />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((design) => (
              <CatalogueListItem key={design.id} design={design} copied={copied === design.id} onCopy={() => copyInquiry(design)} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function CatalogueCard({ design, copied, onCopy }: { design: CatalogueDesign; copied: boolean; onCopy: () => void }) {
  return (
    <article className="jewel-card overflow-hidden bg-card">
      <div className="aspect-square image-placeholder overflow-hidden">
        <AppImage src={design.primaryImage} alt={`${design.designName || design.category} ${design.designNumber}`} width={520} height={520} className="w-full h-full object-cover" />
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-primary">{design.designNumber}</p>
            <h3 className="font-bold text-foreground truncate">{design.designName || design.category}</h3>
          </div>
          <MaterialBadge material={design.material} purity={design.purity} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Info label="Category" value={design.category} />
          <Info label="Subcategory" value={design.subcategory || '-'} />
          <Info label="Weight" value={weightLabel(design)} />
          <Info label="Available" value={`${design.availableSkus.length} pc`} />
        </div>
        {design.description && <p className="text-xs text-muted-foreground line-clamp-2">{design.description}</p>}
        <button onClick={onCopy} className="btn-secondary w-full justify-center py-2 text-xs print:hidden">
          <Share2 size={14} />
          {copied ? 'Copied' : 'Copy Customer Inquiry'}
        </button>
      </div>
    </article>
  );
}

function CatalogueListItem({ design, copied, onCopy }: { design: CatalogueDesign; copied: boolean; onCopy: () => void }) {
  return (
    <article className="jewel-card p-3 grid sm:grid-cols-[120px_1fr_auto] gap-4 items-center bg-card">
      <div className="w-full aspect-square sm:w-[120px] image-placeholder rounded-sm overflow-hidden">
        <AppImage src={design.primaryImage} alt={`${design.designNumber} catalogue image`} width={220} height={220} className="w-full h-full object-cover" />
      </div>
      <div className="space-y-2 min-w-0">
        <div>
          <p className="font-mono text-sm font-bold text-primary">{design.designNumber}</p>
          <h3 className="font-bold text-lg truncate">{design.designName || design.category}</h3>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{design.category}</span>
          <span>{design.subcategory}</span>
          <span>{design.material} {design.purity}</span>
          <span>{weightLabel(design)}</span>
          <span>{design.availableSkus.length} available</span>
        </div>
      </div>
      <button onClick={onCopy} className="btn-secondary py-2 text-xs justify-center print:hidden">
        <Share2 size={14} />
        {copied ? 'Copied' : 'Copy Inquiry'}
      </button>
    </article>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm bg-muted/50 px-2.5 py-2">
      <p className="text-[10px] uppercase font-semibold text-muted-foreground">{label}</p>
      <p className="text-xs font-bold text-foreground truncate">{value}</p>
    </div>
  );
}
