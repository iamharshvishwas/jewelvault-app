'use client';
import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Camera,
  Upload,
  X,
  Star,
  RotateCw,
  ChevronRight,
  ChevronLeft,
  Plus,
  Trash2,
  CheckCircle2,
  Sparkles,
  ArrowLeft,
  GripVertical,
  Image as ImageIcon,
  Info,
  Tag,
  Package,
} from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { PREVIEW_MODE, useSession } from '@/lib/authStore';
import { isApiError, newUuid } from '@/lib/api/client';
import {
  addDesign,
  createDesign,
  designSaveMessage,
  NUMBER_ASSIGNED_WHEN_SAVED,
  reserveNextDesignNumber,
  type CreatedDesign,
  type NewDesignInput,
} from '@/lib/designStore';
import type { Design, Sku, SkuStatus } from '@/lib/mockData';
import { BUSINESS_LOCATION } from '@/lib/businessConfig';
import {
  createCategory,
  createSubcategory,
  getCategories,
  getCategoryPrefix,
  getSubcategories,
  suggestCategoryPrefix,
} from '@/lib/catalogStore';
import { SaveError } from '@/lib/cache/edit';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import {
  MAX_ORIGINAL_BYTES,
  currentPhotoRules,
  prepareImage,
  type PhotoToUpload,
} from '@/lib/photos';
import { getSettings } from '@/lib/settingsStore';

// Add Design (spec P2, P4, X8, D9, C6, C7, C11; task WEB06).
//   - Photos: a picture is resized in the browser when it is chosen (longest side 1000 px at JPEG quality 72 and a 320 px thumbnail: src/lib/photos.ts), and a turn is made in the
//     picture itself. The page makes the design's id when Save is first pressed and one id for each photo when it is chosen. Save uploads every photo (the full picture, then the
//     thumbnail) and then makes ONE call to create_design with the ids and the entries (src/lib/designStore.ts); nothing is shown as made until the API has answered. A design row
//     holds photo ids only: this file makes no image text.
//   - Numbers: the design number, the piece numbers and the barcodes are made by the API in the same transaction (L3); the screen says so before Save and shows what the API
//     returned after it.
//   - Save is pressed again for the same action with the same Idempotency-Key when the first try could not be confirmed (C6), so one design is made; the control is off while a save
//     runs and while the banner shows (C7).
//   - The owner's own weight (D9) is a field for the owner only. Everybody else's screen has no such field, and the API refuses one.
// In a preview build (until WEB15) the screen keeps the prototype's behaviour with its sample data, in this page only.

// ─── Types ───────────────────────────────────────────────────────────────────

/** A photo as the page shows it. The pictures themselves, and what is already stored on the server, are in `payloads` (kept between tries of Save). */
interface PickedPhoto {
  /** The id the page made for the photo (C11). A turn makes a new one: a stored photo is never overwritten. */
  photoId: string;
  /** The file the person chose, kept so that a turn can be made again from it. */
  source: File;
  quarterTurns: number;
  /** An address in this page's memory for the thumbnail; given back when the photo goes. */
  previewUrl: string;
  isPrimary: boolean;
}

interface DesignFormData {
  designName: string;
  category: string;
  subcategory: string;
  material: string;
  purity: string;
  sellingMethod: string;
  description: string;
  tags: string;
  notes: string;
}

/** One row of the stock table: a group of identical pieces. */
interface GroupRow {
  id: string;
  pieces: string;
  grossWeight: string;
  originalNetWeight: string;
  customerNetWeight: string;
  stones: string;
  stoneWeight: string;
  kundan: string;
  kundanWeight: string;
  piroi: string;
  labour: string;
  retailLabour: string;
  semiWholesaleLabour: string;
  wholesaleLabour: string;
  notes: string;
}

/** What the success screen shows: the numbers the API gave. */
interface CreatedSummary {
  designNumber: string;
  pieces: Array<{ skuNumber: string; barcode: string }>;
}

const EMPTY_FORM: DesignFormData = {
  designName: '',
  category: '',
  subcategory: '',
  material: '',
  purity: '',
  sellingMethod: '',
  description: '',
  tags: '',
  notes: '',
};

let groupCounter = 0;
/** The key of a new row of the table, from a count: it is only a key for the page, never sent. Called from handlers only. */
const nextGroupId = () => {
  groupCounter += 1;
  return `group-${groupCounter}`;
};

const emptyGroup = (id: string): GroupRow => ({
  id,
  pieces: '1',
  grossWeight: '',
  originalNetWeight: '',
  customerNetWeight: '',
  stones: '',
  stoneWeight: '',
  kundan: '',
  kundanWeight: '',
  piroi: '',
  labour: '',
  retailLabour: '',
  semiWholesaleLabour: '',
  wholesaleLabour: '',
  notes: '',
});

// ─── Constants ───────────────────────────────────────────────────────────────

const GOLD_PURITIES = ['18K', '20K', '22K', '24K', 'Custom'];
const SILVER_PURITIES = ['800', '925', '999', 'Custom'];

// ─── Step Indicator ──────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: number }) {
  const steps = [
    { num: 1, label: 'Upload Images', icon: <ImageIcon size={14} /> },
    { num: 2, label: 'Design Details', icon: <Info size={14} /> },
    { num: 3, label: 'Create SKUs', icon: <Package size={14} /> },
  ];
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((s, i) => (
        <React.Fragment key={s.num}>
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 ${
                step > s.num
                  ? 'bg-primary text-primary-foreground'
                  : step === s.num
                    ? 'bg-primary text-primary-foreground ring-4 ring-primary/20'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {step > s.num ? <CheckCircle2 size={14} /> : s.num}
            </div>
            <span
              className={`text-sm font-medium hidden sm:block ${
                step === s.num ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={`flex-1 h-px mx-3 transition-all duration-200 ${
                step > s.num ? 'bg-primary' : 'bg-border'
              }`}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Step 1: Image Upload ─────────────────────────────────────────────────────

function ImageUploadStep({
  photos,
  maxPhotos,
  notice,
  busy,
  onAddFiles,
  onRemove,
  onSetPrimary,
  onRotate,
}: {
  photos: PickedPhoto[];
  /** How many photos a design can have (the setting `photos`, P1). */
  maxPhotos: number;
  notice: string;
  busy: boolean;
  onAddFiles: (files: FileList | null) => void;
  onRemove: (photoId: string) => void;
  onSetPrimary: (photoId: string) => void;
  onRotate: (photoId: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const full = photos.length >= maxPhotos;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    onAddFiles(e.dataTransfer.files);
  };

  // the same file chosen again must still fire a change
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    onAddFiles(e.target.files);
    e.target.value = '';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground mb-1">Upload Design Images</h2>
        <p className="text-sm text-muted-foreground">
          Add up to {maxPhotos} jewellery photographs. The primary image will appear throughout
          inventory and billing.
        </p>
      </div>

      {notice && (
        <div
          role="alert"
          data-testid="photo-notice"
          className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm font-medium text-amber-800"
        >
          {notice}
        </div>
      )}

      {/* Upload Area */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200 cursor-pointer ${
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-muted/30'
        }`}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center">
            <Upload size={24} className="text-primary" />
          </div>
          <div>
            <p className="font-semibold text-foreground">Drag & drop images here</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {busy ? 'Preparing the pictures…' : 'or click to browse files'}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            JPG, PNG, WEBP — resized automatically, up to {maxPhotos} photos
          </p>
        </div>
        <input
          ref={fileInputRef}
          data-testid="photo-input"
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={picked}
        />
      </div>

      {/* Camera Capture */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground font-medium">OR</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <button
        type="button"
        onClick={() => cameraInputRef.current?.click()}
        disabled={busy || full}
        className="w-full flex items-center justify-center gap-2.5 py-3 px-4 border border-border rounded-xl hover:bg-muted/40 hover:border-primary/40 transition-all duration-200 text-sm font-medium text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Camera size={18} className="text-primary" />
        Take Photo with Camera
      </button>
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={picked}
      />

      {/* Image Grid */}
      {photos.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">
              {photos.length} image{photos.length !== 1 ? 's' : ''} added
            </h3>
            <span className="text-xs text-muted-foreground">Click ★ to set primary</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {photos.map((photo) => (
              <div
                key={photo.photoId}
                data-testid="photo-tile"
                className={`relative group rounded-xl overflow-hidden aspect-square border-2 transition-all duration-200 ${
                  photo.isPrimary
                    ? 'border-primary shadow-md'
                    : 'border-border hover:border-primary/40'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a picture in this page's memory, not a file of the site */}
                <img
                  src={photo.previewUrl}
                  alt="Design"
                  className="w-full h-full object-cover transition-transform duration-300"
                />
                {photo.isPrimary && (
                  <div className="absolute top-1.5 left-1.5 bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-1">
                    <Star size={10} fill="currentColor" /> Primary
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSetPrimary(photo.photoId);
                    }}
                    title="Set as primary"
                    className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center hover:bg-white transition-colors"
                  >
                    <Star
                      size={14}
                      className={photo.isPrimary ? 'text-primary fill-primary' : 'text-foreground'}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRotate(photo.photoId);
                    }}
                    disabled={busy}
                    title="Rotate"
                    className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center hover:bg-white transition-colors disabled:opacity-50"
                  >
                    <RotateCw size={14} className="text-foreground" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(photo.photoId);
                    }}
                    title="Remove"
                    className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center hover:bg-red-50 transition-colors"
                  >
                    <X size={14} className="text-red-500" />
                  </button>
                </div>
              </div>
            ))}
            {/* Add more */}
            {!full && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="aspect-square rounded-xl border-2 border-dashed border-border hover:border-primary/50 hover:bg-muted/30 flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:text-primary transition-all duration-200 disabled:opacity-50"
              >
                <Plus size={20} />
                <span className="text-xs font-medium">Add More</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 2: Design Details ───────────────────────────────────────────────────

function DesignDetailsStep({
  form,
  onChange,
  generatedDesignNumber,
}: {
  form: DesignFormData;
  onChange: (field: keyof DesignFormData, value: string) => void;
  generatedDesignNumber: string;
}) {
  // drawn again when a category or a sub-category arrives from the server (a new one is shown only after the API has made it, C11)
  useRowCacheVersion('categories', 'subcategories');
  const categories = getCategories();
  const [newCategory, setNewCategory] = useState('');
  const [newCategoryPrefix, setNewCategoryPrefix] = useState('');
  const [newSubcategory, setNewSubcategory] = useState('');
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState('');
  const purities =
    form.material === 'Gold' ? GOLD_PURITIES : form.material === 'Silver' ? SILVER_PURITIES : [];
  const subcats = getSubcategories(form.category);

  const handleAddCategory = async () => {
    if (adding) return;
    setAdding(true);
    setProblem('');
    try {
      const prefix = newCategoryPrefix.trim() || suggestCategoryPrefix(newCategory);
      const category = await createCategory(newCategory, prefix);
      onChange('category', category);
      onChange('subcategory', '');
      setNewCategory('');
      setNewCategoryPrefix('');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to add category.');
    } finally {
      setAdding(false);
    }
  };

  const handleAddSubcategory = async () => {
    if (adding) return;
    setAdding(true);
    setProblem('');
    try {
      const subcategory = await createSubcategory(form.category, newSubcategory);
      onChange('subcategory', subcategory);
      setNewSubcategory('');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to add subcategory.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground mb-1">Design Details</h2>
        <p className="text-sm text-muted-foreground">
          Fill in the design metadata. A unique Design Number will be auto-generated on save.
        </p>
      </div>

      {/* Auto Design Number Preview */}
      <div className="flex items-center gap-3 p-4 bg-secondary rounded-xl border border-border">
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Sparkles size={18} className="text-primary" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
            Auto-Generated Design Number
          </p>
          <p
            data-testid="design-number-preview"
            className="text-lg font-bold text-primary font-mono tracking-wider"
          >
            {generatedDesignNumber}
          </p>
        </div>
        <div className="ml-auto">
          <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-medium">
            Auto
          </span>
        </div>
      </div>

      {problem && (
        <div
          role="alert"
          className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm font-medium text-red-600"
        >
          {problem}
        </div>
      )}

      {/* Form Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Design Name */}
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Design Name <span className="text-muted-foreground font-normal">(optional)</span>
            <input
              type="text"
              value={form.designName}
              onChange={(e) => onChange('designName', e.target.value)}
              placeholder="e.g. Bridal Kundan Necklace Set"
              className="mt-1.5 w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
            />
          </label>
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Category <span className="text-red-500">*</span>
            <select
              data-testid="category-select"
              value={form.category}
              onChange={(e) => {
                onChange('category', e.target.value);
                onChange('subcategory', '');
              }}
              className="mt-1.5 w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all appearance-none"
            >
              <option value="">Select category</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 mt-2">
            <input
              type="text"
              aria-label="New category name"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="Add new category"
              className="flex-1 min-w-0 px-3 py-2 bg-card border border-input rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
            />
            {/* the prefix of the design numbers is written once, when the category is made (L3) */}
            {!PREVIEW_MODE && newCategory.trim() !== '' && (
              <input
                type="text"
                aria-label="Prefix of the new category"
                value={newCategoryPrefix}
                onChange={(e) => setNewCategoryPrefix(e.target.value.toUpperCase())}
                placeholder={suggestCategoryPrefix(newCategory) || 'PREFIX'}
                maxLength={6}
                className="w-24 px-3 py-2 bg-card border border-input rounded-lg text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
              />
            )}
            <SaveButton
              type="button"
              onClick={handleAddCategory}
              disabled={adding || newCategory.trim() === ''}
              className="px-3 py-2 rounded-lg bg-secondary text-xs font-semibold text-foreground hover:border-primary border border-border transition-all disabled:opacity-50"
            >
              Add
            </SaveButton>
          </div>
        </div>

        {/* Subcategory */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Sub-category
            <select
              data-testid="subcategory-select"
              value={form.subcategory}
              onChange={(e) => onChange('subcategory', e.target.value)}
              disabled={!form.category}
              className="mt-1.5 w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all appearance-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">Select sub-category</option>
              {subcats.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 mt-2">
            <input
              type="text"
              aria-label="New sub-category name"
              value={newSubcategory}
              onChange={(e) => setNewSubcategory(e.target.value)}
              disabled={!form.category}
              placeholder="Add new sub-category"
              className="flex-1 min-w-0 px-3 py-2 bg-card border border-input rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all disabled:opacity-50"
            />
            <SaveButton
              type="button"
              onClick={handleAddSubcategory}
              disabled={adding || !form.category || newSubcategory.trim() === ''}
              className="px-3 py-2 rounded-lg bg-secondary text-xs font-semibold text-foreground hover:border-primary border border-border transition-all disabled:opacity-50"
            >
              Add
            </SaveButton>
          </div>
        </div>

        {/* Base Material */}
        <div>
          <p className="block text-sm font-medium text-foreground mb-1.5">
            Base Material <span className="text-red-500">*</span>
          </p>
          <div className="flex gap-2">
            {['Gold', 'Silver'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  onChange('material', m);
                  onChange('purity', '');
                }}
                className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-semibold transition-all duration-200 ${
                  form.material === m
                    ? m === 'Gold'
                      ? 'bg-amber-50 border-amber-400 text-amber-700'
                      : 'bg-slate-50 border-slate-400 text-slate-700'
                    : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                {m === 'Gold' ? '🥇' : '🥈'} {m}
              </button>
            ))}
          </div>
        </div>

        {/* Purity */}
        <div>
          <p className="block text-sm font-medium text-foreground mb-1.5">
            Purity <span className="text-red-500">*</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {purities.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">Select material first</p>
            ) : (
              purities.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onChange('purity', p)}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all duration-200 ${
                    form.purity === p
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  {p}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Selling Method */}
        <div className="sm:col-span-2">
          <p className="block text-sm font-medium text-foreground mb-1.5">
            Selling Method <span className="text-red-500">*</span>
          </p>
          <div className="flex gap-3">
            {['By Weight', 'Per Piece'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChange('sellingMethod', m)}
                className={`flex-1 py-2.5 px-4 rounded-lg border text-sm font-medium transition-all duration-200 ${
                  form.sellingMethod === m
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                {m === 'By Weight' ? '⚖️' : '🔢'} {m}
              </button>
            ))}
          </div>
        </div>

        {/* Description */}
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Description
            <textarea
              value={form.description}
              onChange={(e) => onChange('description', e.target.value)}
              rows={3}
              placeholder="Describe the design, craftsmanship, occasion..."
              className="mt-1.5 w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all resize-none"
            />
          </label>
        </div>

        {/* Tags */}
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Tags / Keywords
            <div className="relative mt-1.5">
              <Tag
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                value={form.tags}
                onChange={(e) => onChange('tags', e.target.value)}
                placeholder="bridal, kundan, antique, wedding (comma separated)"
                className="w-full pl-8 pr-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
              />
            </div>
          </label>
        </div>

        {/* Notes */}
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Notes
            <textarea
              value={form.notes}
              onChange={(e) => onChange('notes', e.target.value)}
              rows={2}
              placeholder="Internal notes (not shown to customers)..."
              className="mt-1.5 w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all resize-none"
            />
          </label>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Bulk SKU Creation ────────────────────────────────────────────────

function BulkSkuStep({
  designNumber,
  sellingMethod,
  skus,
  showOriginalWeight,
  onSkusChange,
}: {
  designNumber: string;
  sellingMethod: string;
  skus: GroupRow[];
  /** D9: only the owner's screen has the field for the original net weight. */
  showOriginalWeight: boolean;
  onSkusChange: (rows: GroupRow[]) => void;
}) {
  const [showQtyPrompt, setShowQtyPrompt] = React.useState(false);
  const [qtyInput, setQtyInput] = React.useState('1');

  const addSku = () => {
    setQtyInput('1');
    setShowQtyPrompt(true);
  };

  const confirmAddSkus = () => {
    const qty = Math.max(1, Math.min(50, parseInt(qtyInput, 10) || 1));
    const newRows: GroupRow[] = Array.from({ length: qty }, () => emptyGroup(nextGroupId()));
    onSkusChange([...skus, ...newRows]);
    setShowQtyPrompt(false);
  };

  const removeSku = (id: string) => {
    if (skus.length <= 1) return;
    onSkusChange(skus.filter((s) => s.id !== id));
  };

  const updateSku = (id: string, field: keyof GroupRow, value: string) => {
    onSkusChange(skus.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  };

  const totalPhysicalPieces = skus.reduce(
    (total, sku) => total + Math.max(1, Math.min(100, parseInt(sku.pieces, 10) || 1)),
    0
  );
  const isPerPiece = sellingMethod === 'Per Piece';
  const rateLabel = isPerPiece ? 'Rate' : 'Labour';
  const rateUnit = isPerPiece ? '₹/piece' : '₹/g';

  const setQuantity = (qty: number) => {
    if (qty < 1 || qty > 50) return;
    const current = skus.length;
    if (qty > current) {
      const toAdd = qty - current;
      const newRows: GroupRow[] = Array.from({ length: toAdd }, () => emptyGroup(nextGroupId()));
      onSkusChange([...skus, ...newRows]);
    } else {
      onSkusChange(skus.slice(0, qty));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground mb-1">Create Physical SKUs</h2>
        <p className="text-sm text-muted-foreground">
          {isPerPiece
            ? 'Add each piece-rate group, then enter how many physical pieces exist for that group. Every piece gets a unique SKU.'
            : 'Add each weight/detail group, then enter how many physical pieces exist for that group. Every piece gets a unique SKU.'}
        </p>
      </div>

      {/* Number Preview. A real build does not know the numbers: the API makes them when the design is saved (L3). */}
      <div className="p-4 bg-secondary rounded-xl border border-border">
        {PREVIEW_MODE ? (
          <>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2">
              SKUs will be generated as:
            </p>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: Math.min(totalPhysicalPieces, 6) }).map((_, i) => (
                <span
                  key={i}
                  className="font-mono text-sm font-bold text-primary bg-primary/10 px-2.5 py-1 rounded-lg"
                >
                  {designNumber}-{String(i + 1).padStart(getSettings().numbering.skuPadding, '0')}
                </span>
              ))}
              {totalPhysicalPieces > 6 && (
                <span className="text-sm text-muted-foreground py-1">
                  +{totalPhysicalPieces - 6} more
                </span>
              )}
            </div>
          </>
        ) : (
          <p data-testid="sku-count-preview" className="text-sm text-foreground">
            <span className="font-bold text-primary">{totalPhysicalPieces}</span> piece
            {totalPhysicalPieces !== 1 ? 's' : ''} will be made. The design number, the SKU numbers
            and the barcodes are given by the server when the design is saved.
          </p>
        )}
      </div>

      {/* Quantity Quick Set */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">
          {isPerPiece ? 'Rate groups:' : 'Weight groups:'}
        </span>
        <div className="flex gap-1.5">
          {[1, 2, 3, 5, 10].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setQuantity(n)}
              className={`w-9 h-9 rounded-lg border text-sm font-semibold transition-all duration-200 ${
                skus.length === n
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-muted-foreground hover:border-primary/40'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 ml-2">
          <button
            type="button"
            onClick={() => setQuantity(skus.length - 1)}
            className="w-8 h-8 rounded-lg border border-border bg-card text-muted-foreground hover:border-primary/40 flex items-center justify-center text-lg font-bold transition-all"
          >
            −
          </button>
          <span className="w-10 text-center text-sm font-bold text-foreground">{skus.length}</span>
          <button
            type="button"
            onClick={() => setQuantity(skus.length + 1)}
            className="w-8 h-8 rounded-lg border border-border bg-card text-muted-foreground hover:border-primary/40 flex items-center justify-center text-lg font-bold transition-all"
          >
            +
          </button>
        </div>
      </div>

      {/* SKU Rows */}
      <div className="space-y-4">
        {skus.map((sku, index) => (
          <div
            key={sku.id}
            data-testid="piece-group"
            className="border border-border rounded-xl overflow-hidden"
          >
            {/* SKU Header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b border-border">
              <div className="flex items-center gap-2">
                <GripVertical size={14} className="text-muted-foreground" />
                <span className="font-mono text-sm font-bold text-primary">Group {index + 1}</span>
                <span className="text-xs text-muted-foreground">
                  {Math.max(1, parseInt(sku.pieces, 10) || 1)} physical SKU(s)
                </span>
              </div>
              <button
                type="button"
                onClick={() => removeSku(sku.id)}
                disabled={skus.length <= 1}
                aria-label={`Remove group ${index + 1}`}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {/* SKU Fields */}
            <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <SkuField
                label="Pieces with this weight"
                value={sku.pieces}
                onChange={(v) => updateSku(sku.id, 'pieces', v)}
                placeholder="1"
                isInteger
              />
              <SkuField
                label="Gross Weight (g)"
                value={sku.grossWeight}
                onChange={(v) => updateSku(sku.id, 'grossWeight', v)}
                placeholder="0.000"
              />
              {showOriginalWeight && (
                <SkuField
                  label="Original Net Wt (g) 🔒"
                  value={sku.originalNetWeight}
                  onChange={(v) => updateSku(sku.id, 'originalNetWeight', v)}
                  placeholder="0.000"
                  isPrivate
                />
              )}
              <SkuField
                label="Customer Net Wt (g)"
                value={sku.customerNetWeight}
                onChange={(v) => updateSku(sku.id, 'customerNetWeight', v)}
                placeholder="0.000"
              />
              <SkuField
                label="Stones (#)"
                value={sku.stones}
                onChange={(v) => updateSku(sku.id, 'stones', v)}
                placeholder="0"
                isInteger
              />
              <SkuField
                label="Stone Weight (g)"
                value={sku.stoneWeight}
                onChange={(v) => updateSku(sku.id, 'stoneWeight', v)}
                placeholder="0.000"
              />
              <SkuField
                label="Kundan (#)"
                value={sku.kundan}
                onChange={(v) => updateSku(sku.id, 'kundan', v)}
                placeholder="0"
                isInteger
              />
              <SkuField
                label="Kundan Weight (g)"
                value={sku.kundanWeight}
                onChange={(v) => updateSku(sku.id, 'kundanWeight', v)}
                placeholder="0.000"
              />
              <SkuField
                label="Piroi (₹)"
                value={sku.piroi}
                onChange={(v) => updateSku(sku.id, 'piroi', v)}
                placeholder="0.00"
              />
              <SkuField
                label={`Retail ${rateLabel} (${rateUnit})`}
                value={sku.retailLabour}
                onChange={(v) => updateSku(sku.id, 'retailLabour', v)}
                placeholder="0.00"
              />
              <SkuField
                label={`Semi-Wholesale ${rateLabel} (${rateUnit})`}
                value={sku.semiWholesaleLabour}
                onChange={(v) => updateSku(sku.id, 'semiWholesaleLabour', v)}
                placeholder="0.00"
              />
              <SkuField
                label={`Wholesale ${rateLabel} (${rateUnit})`}
                value={sku.wholesaleLabour}
                onChange={(v) => updateSku(sku.id, 'wholesaleLabour', v)}
                placeholder="0.00"
              />
              <div className="col-span-2 sm:col-span-3 lg:col-span-1">
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Remarks
                  <input
                    type="text"
                    value={sku.notes}
                    onChange={(e) => updateSku(sku.id, 'notes', e.target.value)}
                    placeholder="Optional remarks..."
                    className="mt-1 w-full px-2.5 py-2 bg-card border border-input rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                  />
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add SKU Button */}
      <button
        type="button"
        onClick={addSku}
        className="w-full py-3 border-2 border-dashed border-border rounded-xl text-sm font-medium text-muted-foreground hover:border-primary/50 hover:text-primary hover:bg-primary/5 transition-all duration-200 flex items-center justify-center gap-2"
      >
        <Plus size={16} />
        Add Another Weight Group
      </button>

      {/* Quantity Prompt Modal */}
      {showQtyPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Package size={20} className="text-primary" />
              </div>
              <div>
                <h3 className="text-base font-bold text-foreground">How many pieces?</h3>
                <p className="text-xs text-muted-foreground">
                  Enter the quantity available for this SKU
                </p>
              </div>
            </div>

            <div className="mb-5">
              <label className="block text-xs font-medium text-muted-foreground mb-2">
                Quantity available in stock
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQtyInput(String(Math.max(1, parseInt(qtyInput, 10) - 1 || 1)))}
                  className="w-9 h-9 rounded-lg border border-border bg-secondary text-foreground hover:border-primary/40 flex items-center justify-center text-lg font-bold transition-all flex-shrink-0"
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={qtyInput}
                  onChange={(e) => setQtyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmAddSkus();
                    if (e.key === 'Escape') setShowQtyPrompt(false);
                  }}
                  autoFocus
                  className="flex-1 text-center px-3 py-2.5 bg-background border border-input rounded-lg text-lg font-bold text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                />
                <button
                  type="button"
                  onClick={() => setQtyInput(String(Math.min(50, parseInt(qtyInput, 10) + 1 || 1)))}
                  className="w-9 h-9 rounded-lg border border-border bg-secondary text-foreground hover:border-primary/40 flex items-center justify-center text-lg font-bold transition-all flex-shrink-0"
                >
                  +
                </button>
              </div>
              <div className="flex gap-1.5 mt-3">
                {[1, 2, 3, 5, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setQtyInput(String(n))}
                    className={`flex-1 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
                      qtyInput === String(n)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-secondary border-border text-muted-foreground hover:border-primary/40'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              {parseInt(qtyInput, 10) > 1 && (
                <p className="text-xs text-muted-foreground mt-2 text-center">
                  Will generate{' '}
                  <span className="font-semibold text-primary">{parseInt(qtyInput, 10)}</span> new
                  SKU entries
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowQtyPrompt(false)}
                className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:bg-secondary transition-all"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmAddSkus}
                className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-all"
              >
                Add {parseInt(qtyInput, 10) > 1 ? `${parseInt(qtyInput, 10)} SKUs` : 'SKU'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SkuField({
  label,
  value,
  onChange,
  placeholder,
  isPrivate = false,
  isInteger = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  isPrivate?: boolean;
  isInteger?: boolean;
}) {
  return (
    <div>
      <label
        className={`block text-xs font-medium mb-1 ${isPrivate ? 'text-amber-600' : 'text-muted-foreground'}`}
      >
        {label}
        <input
          type="number"
          step={isInteger ? '1' : '0.001'}
          min="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`mt-1 w-full px-2.5 py-2 bg-card border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all ${
            isPrivate ? 'border-amber-200 bg-amber-50/30' : 'border-input'
          }`}
        />
      </label>
    </div>
  );
}

// ─── Success Screen ───────────────────────────────────────────────────────────

function SuccessScreen({
  created,
  onViewInventory,
  onAddAnother,
}: {
  created: CreatedSummary;
  onViewInventory: () => void;
  onAddAnother: () => void;
}) {
  const skuCount = created.pieces.length;
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center space-y-6">
      <div className="w-20 h-20 rounded-full bg-green-50 flex items-center justify-center">
        <CheckCircle2 size={40} className="text-green-500" />
      </div>
      <div>
        <h2 className="text-2xl font-bold text-foreground mb-2">Design Created!</h2>
        <p className="text-muted-foreground">
          Design{' '}
          <span data-testid="created-design-number" className="font-mono font-bold text-primary">
            {created.designNumber}
          </span>{' '}
          has been created with{' '}
          <span className="font-bold text-foreground">
            {skuCount} SKU{skuCount !== 1 ? 's' : ''}
          </span>
          .
        </p>
      </div>
      <ul
        data-testid="created-pieces"
        className="w-full max-w-sm divide-y divide-border rounded-xl border border-border text-left"
      >
        {created.pieces.map((piece) => (
          <li
            key={piece.skuNumber}
            data-testid="created-piece"
            className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
          >
            <span className="font-mono font-bold text-primary">{piece.skuNumber}</span>
            <span className="font-mono text-xs text-muted-foreground">{piece.barcode}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
        <button
          type="button"
          onClick={onViewInventory}
          className="flex-1 py-3 px-6 bg-primary text-primary-foreground rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors"
        >
          View Inventory
        </button>
        <button
          type="button"
          onClick={onAddAnother}
          className="flex-1 py-3 px-6 border border-border rounded-xl font-semibold text-sm text-foreground hover:bg-muted/40 transition-colors"
        >
          Add Another Design
        </button>
      </div>
    </div>
  );
}

// ─── The preview build's own save (until WEB15) ───────────────────────────────

/** The prototype's save, for a preview build only: sample data in this page, numbers counted here. A real build never gets here; the API makes the numbers. */
function savePreviewDesign(
  form: DesignFormData,
  groups: GroupRow[],
  photoUrls: string[],
  primaryUrl: string,
  designNumber: string
): CreatedSummary {
  const now = new Date().toISOString();
  const designId = `design-${Date.now()}`;
  const numbering = getSettings().numbering;
  let physicalSkuIndex = 0;
  const builtSkus: Sku[] = groups.flatMap((s, groupIdx) => {
    const pieces = Math.max(1, Math.min(100, parseInt(s.pieces, 10) || 1));
    return Array.from({ length: pieces }, (_, pieceIdx) => {
      physicalSkuIndex += 1;
      const skuNumber = `${designNumber}-${String(physicalSkuIndex).padStart(numbering.skuPadding, '0')}`;
      return {
        id: `sku-${Date.now()}-${groupIdx}-${pieceIdx}`,
        skuNumber,
        designId,
        designNumber,
        grossWeight: parseFloat(s.grossWeight) || 0,
        originalNetWeight: parseFloat(s.originalNetWeight) || 0,
        customerNetWeight: parseFloat(s.customerNetWeight) || 0,
        stones: parseInt(s.stones) || 0,
        stoneWeight: parseFloat(s.stoneWeight) || 0,
        kundan: parseInt(s.kundan) || 0,
        kundanWeight: parseFloat(s.kundanWeight) || 0,
        piroi: parseFloat(s.piroi) || 0,
        labour: parseFloat(s.retailLabour || s.labour) || 0,
        retailLabour: parseFloat(s.retailLabour || s.labour) || 0,
        semiWholesaleLabour:
          parseFloat(s.semiWholesaleLabour || s.wholesaleLabour || s.retailLabour || s.labour) || 0,
        wholesaleLabour: parseFloat(s.wholesaleLabour || s.retailLabour || s.labour) || 0,
        status: 'In Stock' as SkuStatus,
        location: BUSINESS_LOCATION,
        barcode: `${numbering.barcodePrefix || 'BC'}-${skuNumber}`,
        createdAt: now,
        createdBy: 'Admin',
        notes: s.notes,
        sellingMethod: form.sellingMethod as 'By Weight' | 'Per Piece',
        purity: form.purity as import('@/lib/mockData').Purity,
        material: form.material as import('@/lib/mockData').Material,
        category: form.category,
        subcategory: form.subcategory,
      };
    });
  });
  const first = groups[0];
  const retail = parseFloat(first?.retailLabour || first?.labour) || 0;
  const newDesign: Design = {
    id: designId,
    designNumber,
    designName: form.designName,
    category: form.category,
    subcategory: form.subcategory,
    material: form.material as import('@/lib/mockData').Material,
    purity: form.purity as import('@/lib/mockData').Purity,
    sellingMethod: form.sellingMethod as 'By Weight' | 'Per Piece',
    description: form.description,
    notes: form.notes,
    tags: form.tags
      ? form.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    images: photoUrls,
    primaryImage: primaryUrl,
    skus: builtSkus,
    createdAt: now,
    createdBy: 'Admin',
    labour: retail,
    retailLabour: retail,
    semiWholesaleLabour:
      parseFloat(
        first?.semiWholesaleLabour || first?.wholesaleLabour || first?.retailLabour || first?.labour
      ) || 0,
    wholesaleLabour:
      parseFloat(first?.wholesaleLabour || first?.retailLabour || first?.labour) || 0,
    piroi: parseFloat(first?.piroi) || 0,
  };
  addDesign(newDesign);
  return {
    designNumber,
    pieces: builtSkus.map((sku) => ({ skuNumber: sku.skuNumber, barcode: sku.barcode })),
  };
}

// ─── Main Client Component ────────────────────────────────────────────────────

function generateDesignNumber(category: string): string {
  const settings = getSettings();
  const prefix = settings.numbering.categoryPrefixes[category] || getCategoryPrefix(category);
  return reserveNextDesignNumber(category, prefix);
}

/** The text of the person's entries that a second Save compares: the same text is the same action (C6). */
const sameAction = (a: string | null, b: string) => a !== null && a === b;

export default function AddDesignClient() {
  const router = useRouter();
  const { role } = useSession();
  const isOwner = role === 'owner';
  const [step, setStep] = useState(1);
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [photoNotice, setPhotoNotice] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [form, setForm] = useState<DesignFormData>(EMPTY_FORM);
  const [groups, setGroups] = useState<GroupRow[]>(() => [emptyGroup('group-0')]);
  const [created, setCreated] = useState<CreatedSummary | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState('');

  // The pictures and what the server already holds of them live outside React's state: they are blobs, and a second Save needs to know which were sent. Changed in handlers only.
  const payloads = useRef(new Map<string, PhotoToUpload>());
  const previewUrls = useRef(new Set<string>());
  const preparingRef = useRef(false);
  const savingRef = useRef(false);
  // The design's id, made when Save is first pressed (P2), and the last try of Save: its entries as text and, if it could not be confirmed, its Idempotency-Key (C6).
  const attempt = useRef<{ designId: string | null; text: string | null; key: string | null }>({
    designId: null,
    text: null,
    key: null,
  });

  // give the pictures' addresses back when the page goes
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const designNumber = PREVIEW_MODE
    ? form.category
      ? generateDesignNumber(form.category)
      : 'XXX-00000'
    : NUMBER_ASSIGNED_WHEN_SAVED;

  const handleFormChange = (field: keyof DesignFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors([]);
  };

  // ---- the photos

  const makePreview = (blob: Blob): string => {
    const url = URL.createObjectURL(blob);
    previewUrls.current.add(url);
    return url;
  };
  const dropPreview = (url: string) => {
    URL.revokeObjectURL(url);
    previewUrls.current.delete(url);
  };

  const addFiles = async (list: FileList | null) => {
    if (!list || preparingRef.current) return;
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const maxPhotos = currentPhotoRules().maxPerDesign;
    const room = Math.max(0, maxPhotos - payloads.current.size);
    const taking = files.slice(0, room);
    const refused = files.length - taking.length;
    preparingRef.current = true;
    setPreparing(true);
    setPhotoNotice('');
    const added: PickedPhoto[] = [];
    const problems: string[] = [];
    try {
      for (const file of taking) {
        if (file.size > MAX_ORIGINAL_BYTES) {
          problems.push('A picture over 25 MB was not added.');
          continue;
        }
        try {
          const made = await prepareImage(file);
          const photoId = newUuid();
          payloads.current.set(photoId, {
            photoId,
            full: made.full,
            thumb: made.thumb,
            stored: { full: null, thumb: null },
          });
          added.push({
            photoId,
            source: file,
            quarterTurns: 0,
            previewUrl: makePreview(made.thumb),
            isPrimary: false,
          });
        } catch (error) {
          problems.push(error instanceof Error ? error.message : 'A picture could not be added.');
        }
      }
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
    if (refused > 0) {
      problems.push(
        `A design can have at most ${maxPhotos} photos. ${
          refused === 1 ? '1 photo was' : `${refused} photos were`
        } not added.`
      );
    }
    setPhotoNotice(problems.join(' '));
    if (added.length === 0) return;
    setPhotos((current) => {
      const next = [...current, ...added];
      if (!next.some((p) => p.isPrimary)) next[0] = { ...next[0], isPrimary: true };
      return next;
    });
    setErrors([]);
  };

  const removePhoto = (photoId: string) => {
    const gone = photos.find((p) => p.photoId === photoId);
    if (gone) dropPreview(gone.previewUrl);
    payloads.current.delete(photoId);
    setPhotoNotice('');
    setPhotos((current) => {
      const next = current.filter((p) => p.photoId !== photoId);
      if (next.length > 0 && !next.some((p) => p.isPrimary))
        next[0] = { ...next[0], isPrimary: true };
      return next;
    });
  };

  const setPrimaryPhoto = (photoId: string) =>
    setPhotos((current) => current.map((p) => ({ ...p, isPrimary: p.photoId === photoId })));

  /** A turn is made in the picture itself, so what is previewed is what is sent. The picture is a new photo (a stored photo is never overwritten): it gets a new id. */
  const rotatePhoto = async (photoId: string) => {
    const photo = photos.find((p) => p.photoId === photoId);
    if (!photo || preparingRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    setPhotoNotice('');
    try {
      const turns = (photo.quarterTurns + 1) % 4;
      const made = await prepareImage(photo.source, { quarterTurns: turns });
      const nextId = newUuid();
      payloads.current.delete(photoId);
      payloads.current.set(nextId, {
        photoId: nextId,
        full: made.full,
        thumb: made.thumb,
        stored: { full: null, thumb: null },
      });
      dropPreview(photo.previewUrl);
      const url = makePreview(made.thumb);
      setPhotos((current) =>
        current.map((p) =>
          p.photoId === photoId
            ? { ...p, photoId: nextId, quarterTurns: turns, previewUrl: url }
            : p
        )
      );
    } catch (error) {
      setPhotoNotice(error instanceof Error ? error.message : 'The picture could not be turned.');
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  };

  // ---- the steps

  const validateStep = (): boolean => {
    const errs: string[] = [];
    if (step === 2) {
      if (!form.category) errs.push('Category is required.');
      if (!form.material) errs.push('Base Material is required.');
      if (!form.purity) errs.push('Purity is required.');
      if (!form.sellingMethod) errs.push('Selling Method is required.');
    }
    setErrors(errs);
    return errs.length === 0;
  };

  const handleNext = () => {
    if (!validateStep()) return;
    setStep((s) => s + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleBack = () => {
    setStep((s) => s - 1);
    setErrors([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ---- Save

  const handleSubmit = async () => {
    if (savingRef.current) return; // a second click while the first is on its way is the same click (C6)
    if (PREVIEW_MODE) {
      try {
        const urls = photos.map((p) =>
          makePreview(payloads.current.get(p.photoId)?.full ?? p.source)
        );
        const primary = photos.findIndex((p) => p.isPrimary);
        setCreated(
          savePreviewDesign(
            form,
            groups,
            urls,
            urls[primary >= 0 ? primary : 0] ?? '/assets/images/no_image.png',
            designNumber
          )
        );
      } catch (error) {
        setErrors([error instanceof Error ? error.message : 'Unable to save this design.']);
      }
      return;
    }

    // the design's id is made once for this screen (P2): the photos are stored under it, and a second try uses it again
    const designId = attempt.current.designId ?? newUuid();
    attempt.current.designId = designId;
    const picked = photos
      .map((p) => payloads.current.get(p.photoId))
      .filter((p): p is PhotoToUpload => p !== undefined);
    const primary = photos.find((p) => p.isPrimary)?.photoId ?? photos[0]?.photoId ?? null;
    const input: NewDesignInput = {
      designId,
      designName: form.designName,
      category: form.category,
      subcategory: form.subcategory,
      material: form.material,
      purity: form.purity,
      sellingMethod: form.sellingMethod,
      description: form.description,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes: form.notes,
      photos: picked,
      primaryPhotoId: primary,
      groups: groups.map((g) => ({
        pieces: g.pieces.trim() === '' ? 1 : Number(g.pieces),
        grossWeight: g.grossWeight,
        // D9: a screen that has no such field sends none
        originalNetWeight: isOwner ? g.originalNetWeight : '',
        customerNetWeight: g.customerNetWeight,
        stones: g.stones,
        stoneWeight: g.stoneWeight,
        kundan: g.kundan,
        kundanWeight: g.kundanWeight,
        piroi: g.piroi,
        retailLabour: g.retailLabour || g.labour,
        semiWholesaleLabour: g.semiWholesaleLabour,
        wholesaleLabour: g.wholesaleLabour,
        notes: g.notes,
      })),
    };
    // the same entries as the last try that could not be confirmed are the same action: the same key makes the design once (C6)
    const text = JSON.stringify({ ...input, photos: picked.map((p) => p.photoId) });
    const key = sameAction(attempt.current.text, text) ? attempt.current.key : null;

    savingRef.current = true;
    setSaving(true);
    setErrors([]);
    setProgress('Saving…');
    try {
      const made: CreatedDesign = await createDesign(input, {
        idempotencyKey: key ?? undefined,
        onProgress: setProgress,
      });
      attempt.current = { designId: null, text: null, key: null };
      setCreated({
        designNumber: made.designNumber,
        pieces: made.pieces.map((p) => ({ skuNumber: p.skuNumber, barcode: p.barcode })),
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      const cause = error instanceof SaveError ? error.origin : error;
      // the call was made and its answer is not known: Save again for the same entries sends the same key
      attempt.current = {
        designId,
        text: isApiError(cause) && cause.unconfirmed && cause.idempotencyKey ? text : null,
        key: isApiError(cause) && cause.unconfirmed ? cause.idempotencyKey : null,
      };
      setErrors([designSaveMessage(error)]);
    } finally {
      savingRef.current = false;
      setSaving(false);
      setProgress('');
    }
  };

  const handleReset = () => {
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    payloads.current.clear();
    attempt.current = { designId: null, text: null, key: null };
    setStep(1);
    setPhotos([]);
    setPhotoNotice('');
    setForm(EMPTY_FORM);
    setGroups([emptyGroup(nextGroupId())]);
    setCreated(null);
    setErrors([]);
  };

  if (created) {
    return (
      <div className="max-w-2xl mx-auto">
        <SuccessScreen
          created={created}
          onViewInventory={() => router.push('/inventory-management')}
          onAddAnother={handleReset}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Page Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={() => router.push('/inventory-management')}
          aria-label="Back to inventory"
          className="w-9 h-9 rounded-xl border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Add New Design</h1>
          <p className="text-sm text-muted-foreground">
            Create a new jewellery design and generate physical SKUs
          </p>
        </div>
      </div>

      {/* Step Indicator */}
      <StepIndicator step={step} />

      {/* Step Content */}
      <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
        {step === 1 && (
          <ImageUploadStep
            photos={photos}
            maxPhotos={currentPhotoRules().maxPerDesign}
            notice={photoNotice}
            busy={preparing}
            onAddFiles={addFiles}
            onRemove={removePhoto}
            onSetPrimary={setPrimaryPhoto}
            onRotate={rotatePhoto}
          />
        )}
        {step === 2 && (
          <DesignDetailsStep
            form={form}
            onChange={handleFormChange}
            generatedDesignNumber={designNumber}
          />
        )}
        {step === 3 && (
          <BulkSkuStep
            designNumber={designNumber}
            sellingMethod={form.sellingMethod}
            skus={groups}
            showOriginalWeight={isOwner}
            onSkusChange={setGroups}
          />
        )}

        {/* Validation Errors */}
        {errors.length > 0 && (
          <div role="alert" className="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl">
            {errors.map((e, i) => (
              <p key={i} className="text-sm text-red-600 font-medium">
                {e}
              </p>
            ))}
          </div>
        )}

        {/* Navigation Buttons */}
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-border">
          <button
            type="button"
            onClick={handleBack}
            disabled={step === 1 || saving}
            className="flex items-center gap-2 px-5 py-2.5 border border-border rounded-xl text-sm font-medium text-foreground hover:bg-muted/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
            Back
          </button>

          <div className="flex items-center gap-1.5">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  n === step ? 'w-6 bg-primary' : n < step ? 'w-3 bg-primary/50' : 'w-3 bg-border'
                }`}
              />
            ))}
          </div>

          {step < 3 ? (
            <button
              type="button"
              onClick={handleNext}
              disabled={preparing}
              className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all disabled:opacity-60"
            >
              Continue
              <ChevronRight size={16} />
            </button>
          ) : (
            // C6, C7: off while a save runs, and while the banner "Offline" or "Waking up" shows
            <SaveButton
              type="button"
              onClick={handleSubmit}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all shadow-md disabled:opacity-60"
            >
              <CheckCircle2 size={16} />
              {saving ? progress || 'Saving…' : 'Save Design & SKUs'}
            </SaveButton>
          )}
        </div>
      </div>

      {/* Step 1 skip note */}
      {step === 1 && (
        <p className="text-center text-xs text-muted-foreground mt-3">Images are optional.</p>
      )}
    </div>
  );
}
