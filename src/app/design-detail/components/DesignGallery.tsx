'use client';
import React, { useState, useSyncExternalStore } from 'react';
import AppImage from '@/components/ui/AppImage';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { getDesigns } from '@/lib/designStore';
import { ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';

// The photos of a design (P2, P3; task WEB06). They come from the API: the design holds photo ids (P4) and the store turns them into addresses on the API's origin
// (NEXT_PUBLIC_API_URL): the full pictures here, the 320 px thumbnails in the strip under the main picture. A design with no photo shows the placeholder.

const noSubscription = () => () => {};
/** The `id` of the address, read when the page is drawn (the page is left and opened again for another design). */
const readIdFromUrl = () => new URLSearchParams(window.location.search).get('id');

export default function DesignGallery() {
  // drawn again when a poll or an edit changes a design
  useRowCacheVersion('designs', 'skus');
  const wantedId = useSyncExternalStore(noSubscription, readIdFromUrl, () => null);
  const designs = getDesigns();
  const design = designs.find((d) => d.id === wantedId) ?? designs[0] ?? null;
  const [picked, setPicked] = useState(0);

  if (!design) {
    return (
      <div className="jewel-card overflow-hidden relative aspect-square image-placeholder flex items-center justify-center bg-muted">
        <span className="text-muted-foreground text-sm">No design selected</span>
      </div>
    );
  }

  const images = design.images?.length
    ? design.images
    : design.primaryImage
      ? [design.primaryImage]
      : [];
  const thumbs = design.thumbs?.length === images.length ? design.thumbs : images;
  const activeIdx = Math.min(picked, Math.max(0, images.length - 1));

  const prev = () => setPicked(activeIdx === 0 ? images.length - 1 : activeIdx - 1);
  const next = () => setPicked(activeIdx === images.length - 1 ? 0 : activeIdx + 1);

  return (
    <div className="space-y-2" data-testid="design-gallery">
      {/* Main Image. The key makes a new image of it when the picture changes: AppImage keeps its first address. */}
      <div className="jewel-card overflow-hidden relative aspect-square image-placeholder">
        <AppImage
          key={images[activeIdx] ?? design.primaryImage}
          src={images[activeIdx] ?? design.primaryImage}
          alt={`${design.designName || design.category} — ${design.designNumber}, view ${activeIdx + 1} of ${images.length}`}
          data-testid="gallery-main"
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
              aria-label="Previous picture"
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-white/80 hover:bg-white rounded-full flex items-center justify-center shadow-jewel transition-all"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={next}
              aria-label="Next picture"
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
              onClick={() => setPicked(idx)}
              className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all ${
                idx === activeIdx ? 'border-primary' : 'border-transparent hover:border-border'
              }`}
            >
              <AppImage
                src={thumbs[idx]}
                alt={`${design.designName || design.designNumber} thumbnail ${idx + 1}`}
                data-testid="gallery-thumb"
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
