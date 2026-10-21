'use client';
import React from 'react';
import Link from 'next/link';
import DesignGallery from './DesignGallery';
import DesignInfoPanel from './DesignInfoPanel';
import DesignTabs from './DesignTabs';
import type { DesignOfPage } from './designOfPage';

/** The design page for what the address names: the design with its pieces, or a plain sentence when there is no such design (never another design). */
export default function DesignDetailView({ state }: { state: DesignOfPage }) {
  if (state.kind !== 'found') return <DesignNotShown missing={state.kind === 'missing'} />;
  const { design } = state;
  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div
        data-testid="design-breadcrumb"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Link href="/inventory-management" className="hover:text-primary transition-colors">
          Inventory
        </Link>
        <span>/</span>
        <Link href="/inventory-management" className="hover:text-primary transition-colors">
          {design.category}
        </Link>
        <span>/</span>
        <span className="text-foreground font-semibold font-mono">{design.designNumber}</span>
      </div>

      {/* Top Section. The key starts the picture and the strip afresh for another design. */}
      <div className="grid grid-cols-1 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 gap-5">
        <div className="lg:col-span-2">
          <DesignGallery key={design.id} design={design} />
        </div>
        <div className="lg:col-span-3">
          <DesignInfoPanel design={design} />
        </div>
      </div>

      {/* The pieces of the design */}
      <DesignTabs design={design} />
    </div>
  );
}

function DesignNotShown({ missing }: { missing: boolean }) {
  return (
    <div
      data-testid={missing ? 'design-missing' : 'design-none'}
      className="jewel-card p-8 text-center max-w-lg mx-auto mt-10"
    >
      <h1 className="text-xl font-bold text-foreground">
        {missing ? 'Design not found' : 'No design selected'}
      </h1>
      <p className="text-sm text-muted-foreground mt-2">
        {missing
          ? 'This design is not in the stock. It may have been removed, or the address may be wrong.'
          : 'Open a design from the inventory to see it here.'}
      </p>
      <Link href="/inventory-management" className="btn-primary mt-5 inline-flex">
        Back to Inventory
      </Link>
    </div>
  );
}
