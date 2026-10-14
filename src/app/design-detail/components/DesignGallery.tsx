'use client';
import React, { useState, useEffect } from 'react';
import AppImage from '@/components/ui/AppImage';
import { getDesigns } from '@/lib/designStore';
import { ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';
import type { Design } from '@/lib/mockData';

function useDesignFromUrl(): Design | null {
  const [design, setDesign] = useState<Design | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const found = getDesigns().find((d) => d.id === id) ?? getDesigns()[0] ?? null;
    setDesign(found);
  }, []);
  return design;
}

export default function DesignGallery() {
  const design = useDesignFromUrl();
  const [activeIdx, setActiveIdx] = useState(0);

  if (!design) {
    return (
      <div className="jewel-card overflow-hidden relative aspect-square image-placeholder flex items-center justify-center bg-muted">
        <span className="text-muted-foreground text-sm">No design selected</span>
      </div>
    );
  }

  const images = design.images?.length ? design.images : design.primaryImage ? [design.primaryImage] : [];

  const prev = () => setActiveIdx((i) => (i === 0 ? images.length - 1 : i - 1));
  const next = () => setActiveIdx((i) => (i === images.length - 1 ? 0 : i + 1));

  return (
    <div className="space-y-2">
      {/* Main Image */}
      <div className="jewel-card overflow-hidden relative aspect-square image-placeholder">
        <AppImage
          src={images[activeIdx] ?? design.primaryImage}
          alt={`${design.designName || design.category} — ${design.designNumber}, view ${activeIdx + 1} of ${images.length}`}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 40vw"
          className="object-cover"
        />
        {/* Nav arrows */}
        {images.length > 1 && (
          <>
            <button
              onClick={prev}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-white/80 hover:bg-white rounded-full flex items-center justify-center shadow-jewel transition-all"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={next}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-white/80 hover:bg-white rounded-full flex items-center justify-center shadow-jewel transition-all"
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}
        {/* Zoom hint */}
        <button className="absolute bottom-2 right-2 w-7 h-7 bg-white/80 hover:bg-white rounded-full flex items-center justify-center shadow-jewel">
          <ZoomIn size={13} />
        </button>
        {/* Counter */}
        {images.length > 0 && (
          <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
            {activeIdx + 1} / {images.length}
          </div>
        )}
      </div>
      {/* Thumbnails */}
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-1">
          {images.map((img, idx) => (
            <button
              key={`thumb-${design.id}-${idx}`}
              onClick={() => setActiveIdx(idx)}
              className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all ${
                idx === activeIdx ? 'border-primary' : 'border-transparent hover:border-border'
              }`}
            >
              <AppImage
                src={img}
                alt={`${design.designName || design.designNumber} thumbnail ${idx + 1}`}
                width={64}
                height={64}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}