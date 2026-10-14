'use client';
import React, { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Camera, Upload, X, Star, RotateCw, ChevronRight, ChevronLeft,
  Plus, Trash2, CheckCircle2, Sparkles, ArrowLeft, GripVertical,
  Image as ImageIcon, Info, Tag, Package
} from 'lucide-react';
import { addDesign, reserveNextDesignNumber } from '@/lib/designStore';
import type { Design, Sku, SkuStatus } from '@/lib/mockData';
import { BUSINESS_LOCATION } from '@/lib/businessConfig';
import { addCategory, addSubcategory, getCategories, getCategoryPrefix, getSubcategories } from '@/lib/catalogStore';
import { getSettings } from '@/lib/settingsStore';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UploadedImage {
  id: string;
  url: string;
  file?: File;
  rotation: number;
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

function imageFileToStoredDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Unable to prepare image preview.'));
      img.onload = () => {
        const maxSide = 1200;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Unable to resize image.'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

interface SkuRow {
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

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORIES = [
  'Necklace Set', 'Pendant Set', 'Ring', 'Earrings', 'Bangles',
  'Bracelet', 'Chain', 'Pendant', 'Kada', 'Anklet',
  'Payal', 'Mangalsutra', 'Nose Pin', 'Brooch', 'Other',
];

const SUBCATEGORIES: Record<string, string[]> = {
  'Necklace Set': ['Bridal', 'Party Wear', 'Casual', 'Temple', 'Antique'],
  'Ring': ['Solitaire', 'Band', 'Cocktail', 'Engagement', 'Wedding'],
  'Earrings': ['Studs', 'Drops', 'Hoops', 'Chandbali', 'Jhumka'],
  'Bangles': ['Plain', 'Kada', 'Filigree', 'Stone Set', 'Antique'],
  'Bracelet': ['Chain', 'Bangle Style', 'Charm', 'Tennis'],
  'Pendant Set': ['Bridal', 'Casual', 'Temple', 'Antique'],
  'Chain': ['Box', 'Rope', 'Figaro', 'Singapore', 'Anchor'],
  'Pendant': ['Plain', 'Stone Set', 'Religious', 'Name'],
  'Kada': ['Plain', 'Stone Set', 'Filigree'],
  'Anklet': ['Plain', 'Stone Set', 'Ghungroo'],
  'Payal': ['Plain', 'Stone Set', 'Ghungroo'],
  'Mangalsutra': ['Short', 'Long', 'Tanmaniya'],
  'Nose Pin': ['Plain', 'Stone Set', 'Nath'],
  'Brooch': ['Plain', 'Stone Set', 'Enamel'],
  'Other': ['Miscellaneous'],
};

const GOLD_PURITIES = ['18K', '20K', '22K', '24K', 'Custom'];
const SILVER_PURITIES = ['800', '925', '999', 'Custom'];

const CATEGORY_PREFIXES: Record<string, string> = {
  'Necklace Set': 'SET',
  'Pendant Set': 'PSET',
  'Ring': 'RING',
  'Earrings': 'ER',
  'Bangles': 'BNG',
  'Bracelet': 'BRC',
  'Chain': 'CHN',
  'Pendant': 'PEND',
  'Kada': 'KADA',
  'Anklet': 'ANK',
  'Payal': 'PAY',
  'Mangalsutra': 'MNG',
  'Nose Pin': 'NP',
  'Brooch': 'BRO',
  'Other': 'OTH',
};

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
  images,
  onImagesChange,
}: {
  images: UploadedImage[];
  onImagesChange: (imgs: UploadedImage[]) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      try {
        const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
        const newImgs: UploadedImage[] = await Promise.all(
          imageFiles.map(async (file) => ({
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            url: await imageFileToStoredDataUrl(file),
            file,
            rotation: 0,
            isPrimary: images.length === 0,
          }))
        );
        if (newImgs.length === 0) return;
        const updated = [...images, ...newImgs];
        if (!updated.some((i) => i.isPrimary)) updated[0].isPrimary = true;
        onImagesChange(updated);
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Unable to save image locally.');
      }
    },
    [images, onImagesChange]
  );

  const removeImage = (id: string) => {
    const filtered = images.filter((i) => i.id !== id);
    if (filtered.length > 0 && !filtered.some((i) => i.isPrimary)) {
      filtered[0].isPrimary = true;
    }
    onImagesChange(filtered);
  };

  const setPrimary = (id: string) => {
    onImagesChange(images.map((i) => ({ ...i, isPrimary: i.id === id })));
  };

  const rotateImage = (id: string) => {
    onImagesChange(
      images.map((i) => (i.id === id ? { ...i, rotation: (i.rotation + 90) % 360 } : i))
    );
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground mb-1">Upload Design Images</h2>
        <p className="text-sm text-muted-foreground">
          Add one or more jewellery photographs. The primary image will appear throughout inventory and billing.
        </p>
      </div>

      {/* Upload Area */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200 cursor-pointer ${
          dragOver
            ? 'border-primary bg-primary/5' :'border-border hover:border-primary/50 hover:bg-muted/30'
        }`}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-secondary flex items-center justify-center">
            <Upload size={24} className="text-primary" />
          </div>
          <div>
            <p className="font-semibold text-foreground">Drag & drop images here</p>
            <p className="text-sm text-muted-foreground mt-0.5">or click to browse files</p>
          </div>
          <p className="text-xs text-muted-foreground">JPG, PNG, WEBP up to 10MB each</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
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
        className="w-full flex items-center justify-center gap-2.5 py-3 px-4 border border-border rounded-xl hover:bg-muted/40 hover:border-primary/40 transition-all duration-200 text-sm font-medium text-foreground"
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
        onChange={(e) => addFiles(e.target.files)}
      />

      {/* Image Grid */}
      {images.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">
              {images.length} image{images.length !== 1 ? 's' : ''} added
            </h3>
            <span className="text-xs text-muted-foreground">Click ★ to set primary</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {images.map((img) => (
              <div
                key={img.id}
                className={`relative group rounded-xl overflow-hidden aspect-square border-2 transition-all duration-200 ${
                  img.isPrimary ? 'border-primary shadow-md' : 'border-border hover:border-primary/40'
                }`}
              >
                <img
                  src={img.url}
                  alt="Design"
                  className="w-full h-full object-cover transition-transform duration-300"
                  style={{ transform: `rotate(${img.rotation}deg)` }}
                />
                {img.isPrimary && (
                  <div className="absolute top-1.5 left-1.5 bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-1">
                    <Star size={10} fill="currentColor" /> Primary
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPrimary(img.id); }}
                    title="Set as primary"
                    className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center hover:bg-white transition-colors"
                  >
                    <Star size={14} className={img.isPrimary ? 'text-primary fill-primary' : 'text-foreground'} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); rotateImage(img.id); }}
                    title="Rotate"
                    className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center hover:bg-white transition-colors"
                  >
                    <RotateCw size={14} className="text-foreground" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeImage(img.id); }}
                    title="Remove"
                    className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center hover:bg-red-50 transition-colors"
                  >
                    <X size={14} className="text-red-500" />
                  </button>
                </div>
              </div>
            ))}
            {/* Add more */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="aspect-square rounded-xl border-2 border-dashed border-border hover:border-primary/50 hover:bg-muted/30 flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:text-primary transition-all duration-200"
            >
              <Plus size={20} />
              <span className="text-xs font-medium">Add More</span>
            </button>
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
  const [categories, setCategories] = useState<string[]>(() => getCategories());
  const [newCategory, setNewCategory] = useState('');
  const [newSubcategory, setNewSubcategory] = useState('');
  const [subcategoryTick, setSubcategoryTick] = useState(0);
  const purities = form.material === 'Gold' ? GOLD_PURITIES : form.material === 'Silver' ? SILVER_PURITIES : [];
  void subcategoryTick;
  const subcats = getSubcategories(form.category);

  const handleAddCategory = () => {
    try {
      const category = addCategory(newCategory);
      setCategories(getCategories());
      onChange('category', category);
      onChange('subcategory', '');
      setNewCategory('');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to add category.');
    }
  };

  const handleAddSubcategory = () => {
    try {
      const subcategory = addSubcategory(form.category, newSubcategory);
      setSubcategoryTick((value) => value + 1);
      onChange('subcategory', subcategory);
      setNewSubcategory('');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to add subcategory.');
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
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Auto-Generated Design Number</p>
          <p className="text-lg font-bold text-primary font-mono tracking-wider">{generatedDesignNumber}</p>
        </div>
        <div className="ml-auto">
          <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-medium">Auto</span>
        </div>
      </div>

      {/* Form Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Design Name */}
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Design Name <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <input
            type="text"
            value={form.designName}
            onChange={(e) => onChange('designName', e.target.value)}
            placeholder="e.g. Bridal Kundan Necklace Set"
            className="w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
          />
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Category <span className="text-red-500">*</span>
          </label>
          <select
            value={form.category}
            onChange={(e) => { onChange('category', e.target.value); onChange('subcategory', ''); }}
            className="w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all appearance-none"
          >
            <option value="">Select category</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div className="flex gap-2 mt-2">
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="Add new category"
              className="flex-1 px-3 py-2 bg-card border border-input rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
            />
            <button
              type="button"
              onClick={handleAddCategory}
              className="px-3 py-2 rounded-lg bg-secondary text-xs font-semibold text-foreground hover:border-primary border border-border transition-all"
            >
              Add
            </button>
          </div>
        </div>

        {/* Subcategory */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Sub-category</label>
          <select
            value={form.subcategory}
            onChange={(e) => onChange('subcategory', e.target.value)}
            disabled={!form.category}
            className="w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all appearance-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">Select sub-category</option>
            {subcats.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="flex gap-2 mt-2">
            <input
              type="text"
              value={newSubcategory}
              onChange={(e) => setNewSubcategory(e.target.value)}
              disabled={!form.category}
              placeholder="Add new sub-category"
              className="flex-1 px-3 py-2 bg-card border border-input rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleAddSubcategory}
              disabled={!form.category}
              className="px-3 py-2 rounded-lg bg-secondary text-xs font-semibold text-foreground hover:border-primary border border-border transition-all disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>

        {/* Base Material */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Base Material <span className="text-red-500">*</span>
          </label>
          <div className="flex gap-2">
            {['Gold', 'Silver'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { onChange('material', m); onChange('purity', ''); }}
                className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-semibold transition-all duration-200 ${
                  form.material === m
                    ? m === 'Gold' ?'bg-amber-50 border-amber-400 text-amber-700' :'bg-slate-50 border-slate-400 text-slate-700' :'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                {m === 'Gold' ? '🥇' : '🥈'} {m}
              </button>
            ))}
          </div>
        </div>

        {/* Purity */}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Purity <span className="text-red-500">*</span>
          </label>
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
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Selling Method <span className="text-red-500">*</span>
          </label>
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
          <label className="block text-sm font-medium text-foreground mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => onChange('description', e.target.value)}
            rows={3}
            placeholder="Describe the design, craftsmanship, occasion..."
            className="w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all resize-none"
          />
        </div>

        {/* Tags */}
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Tags / Keywords
          </label>
          <div className="relative">
            <Tag size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={form.tags}
              onChange={(e) => onChange('tags', e.target.value)}
              placeholder="bridal, kundan, antique, wedding (comma separated)"
              className="w-full pl-8 pr-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
            />
          </div>
        </div>

        {/* Notes */}
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-foreground mb-1.5">Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => onChange('notes', e.target.value)}
            rows={2}
            placeholder="Internal notes (not shown to customers)..."
            className="w-full px-3 py-2.5 bg-card border border-input rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all resize-none"
          />
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
  onSkusChange,
}: {
  designNumber: string;
  sellingMethod: string;
  skus: SkuRow[];
  onSkusChange: (rows: SkuRow[]) => void;
}) {
  const [showQtyPrompt, setShowQtyPrompt] = React.useState(false);
  const [qtyInput, setQtyInput] = React.useState('1');

  const makeSkuRow = (): SkuRow => ({
    id: `sku-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  const addSku = () => {
    setQtyInput('1');
    setShowQtyPrompt(true);
  };

  const confirmAddSkus = () => {
    const qty = Math.max(1, Math.min(50, parseInt(qtyInput, 10) || 1));
    const newRows: SkuRow[] = Array.from({ length: qty }, () => makeSkuRow());
    onSkusChange([...skus, ...newRows]);
    setShowQtyPrompt(false);
  };

  const removeSku = (id: string) => {
    if (skus.length <= 1) return;
    onSkusChange(skus.filter((s) => s.id !== id));
  };

  const updateSku = (id: string, field: keyof SkuRow, value: string) => {
    onSkusChange(skus.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  };

  const totalPhysicalPieces = skus.reduce(
    (total, sku) => total + Math.max(1, Math.min(100, parseInt(sku.pieces, 10) || 1)),
    0
  );
  const skuPadding = getSettings().numbering.skuPadding;
  const isPerPiece = sellingMethod === 'Per Piece';
  const rateLabel = isPerPiece ? 'Rate' : 'Labour';
  const rateUnit = isPerPiece ? '₹/piece' : '₹/g';

  const setQuantity = (qty: number) => {
    if (qty < 1 || qty > 50) return;
    const current = skus.length;
    if (qty > current) {
      const toAdd = qty - current;
      const newRows: SkuRow[] = Array.from({ length: toAdd }, () => makeSkuRow());
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

      {/* Design Number Preview */}
      <div className="p-4 bg-secondary rounded-xl border border-border">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2">SKUs will be generated as:</p>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: Math.min(totalPhysicalPieces, 6) }).map((_, i) => (
            <span key={i} className="font-mono text-sm font-bold text-primary bg-primary/10 px-2.5 py-1 rounded-lg">
              {designNumber}-{String(i + 1).padStart(skuPadding, '0')}
            </span>
          ))}
          {totalPhysicalPieces > 6 && (
            <span className="text-sm text-muted-foreground py-1">+{totalPhysicalPieces - 6} more</span>
          )}
        </div>
      </div>

      {/* Quantity Quick Set */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">{isPerPiece ? 'Rate groups:' : 'Weight groups:'}</span>
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
          <div key={sku.id} className="border border-border rounded-xl overflow-hidden">
            {/* SKU Header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b border-border">
              <div className="flex items-center gap-2">
                <GripVertical size={14} className="text-muted-foreground" />
                <span className="font-mono text-sm font-bold text-primary">
                  Group {index + 1}
                </span>
                <span className="text-xs text-muted-foreground">
                  {Math.max(1, parseInt(sku.pieces, 10) || 1)} physical SKU(s)
                </span>
              </div>
              <button
                type="button"
                onClick={() => removeSku(sku.id)}
                disabled={skus.length <= 1}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {/* SKU Fields */}
            <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <SkuField label="Pieces with this weight" value={sku.pieces} onChange={(v) => updateSku(sku.id, 'pieces', v)} placeholder="1" isInteger />
              <SkuField label="Gross Weight (g)" value={sku.grossWeight} onChange={(v) => updateSku(sku.id, 'grossWeight', v)} placeholder="0.000" />
              <SkuField label="Original Net Wt (g) 🔒" value={sku.originalNetWeight} onChange={(v) => updateSku(sku.id, 'originalNetWeight', v)} placeholder="0.000" isPrivate />
              <SkuField label="Customer Net Wt (g)" value={sku.customerNetWeight} onChange={(v) => updateSku(sku.id, 'customerNetWeight', v)} placeholder="0.000" />
              <SkuField label="Stones (#)" value={sku.stones} onChange={(v) => updateSku(sku.id, 'stones', v)} placeholder="0" isInteger />
              <SkuField label="Stone Weight (g)" value={sku.stoneWeight} onChange={(v) => updateSku(sku.id, 'stoneWeight', v)} placeholder="0.000" />
              <SkuField label="Kundan (#)" value={sku.kundan} onChange={(v) => updateSku(sku.id, 'kundan', v)} placeholder="0" isInteger />
              <SkuField label="Kundan Weight (g)" value={sku.kundanWeight} onChange={(v) => updateSku(sku.id, 'kundanWeight', v)} placeholder="0.000" />
              <SkuField label="Piroi (₹)" value={sku.piroi} onChange={(v) => updateSku(sku.id, 'piroi', v)} placeholder="0.00" />
              <SkuField label={`Retail ${rateLabel} (${rateUnit})`} value={sku.retailLabour} onChange={(v) => updateSku(sku.id, 'retailLabour', v)} placeholder="0.00" />
              <SkuField label={`Semi-Wholesale ${rateLabel} (${rateUnit})`} value={sku.semiWholesaleLabour} onChange={(v) => updateSku(sku.id, 'semiWholesaleLabour', v)} placeholder="0.00" />
              <SkuField label={`Wholesale ${rateLabel} (${rateUnit})`} value={sku.wholesaleLabour} onChange={(v) => updateSku(sku.id, 'wholesaleLabour', v)} placeholder="0.00" />
              <div className="col-span-2 sm:col-span-3 lg:col-span-1">
                <label className="block text-xs font-medium text-muted-foreground mb-1">Remarks</label>
                <input
                  type="text"
                  value={sku.notes}
                  onChange={(e) => updateSku(sku.id, 'notes', e.target.value)}
                  placeholder="Optional remarks..."
                  className="w-full px-2.5 py-2 bg-card border border-input rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
                />
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
                <p className="text-xs text-muted-foreground">Enter the quantity available for this SKU</p>
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
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmAddSkus(); if (e.key === 'Escape') setShowQtyPrompt(false); }}
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
                  Will generate <span className="font-semibold text-primary">{parseInt(qtyInput, 10)}</span> new SKU entries
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
      <label className={`block text-xs font-medium mb-1 ${isPrivate ? 'text-amber-600' : 'text-muted-foreground'}`}>
        {label}
      </label>
      <input
        type="number"
        step={isInteger ? '1' : '0.001'}
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-2.5 py-2 bg-card border rounded-lg text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all ${
          isPrivate ? 'border-amber-200 bg-amber-50/30' : 'border-input'
        }`}
      />
    </div>
  );
}

// ─── Success Screen ───────────────────────────────────────────────────────────

function SuccessScreen({
  designNumber,
  skuCount,
  onViewInventory,
  onAddAnother,
}: {
  designNumber: string;
  skuCount: number;
  onViewInventory: () => void;
  onAddAnother: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center space-y-6">
      <div className="w-20 h-20 rounded-full bg-green-50 flex items-center justify-center">
        <CheckCircle2 size={40} className="text-green-500" />
      </div>
      <div>
        <h2 className="text-2xl font-bold text-foreground mb-2">Design Created!</h2>
        <p className="text-muted-foreground">
          Design <span className="font-mono font-bold text-primary">{designNumber}</span> has been created with{' '}
          <span className="font-bold text-foreground">{skuCount} SKU{skuCount !== 1 ? 's' : ''}</span>.
        </p>
      </div>
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

// ─── Main Client Component ────────────────────────────────────────────────────

function generateDesignNumber(category: string): string {
  const settings = getSettings();
  const prefix = settings.numbering.categoryPrefixes[category] || getCategoryPrefix(category);
  return reserveNextDesignNumber(category, prefix);
}

export default function AddDesignClient() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [form, setForm] = useState<DesignFormData>({
    designName: '',
    category: '',
    subcategory: '',
    material: '',
    purity: '',
    sellingMethod: '',
    description: '',
    tags: '',
    notes: '',
  });
  const [skus, setSkus] = useState<SkuRow[]>([
    {
      id: `sku-init-${Date.now()}`,
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
    },
  ]);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [savedDesignNumber, setSavedDesignNumber] = useState('');
  const [savedSkuCount, setSavedSkuCount] = useState(0);

  const designNumber = form.category
    ? generateDesignNumber(form.category)
    : 'XXX-00000';

  const handleFormChange = (field: keyof DesignFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors([]);
  };

  const validateStep = (): boolean => {
    const errs: string[] = [];
    if (step === 1) {
      // Images optional but recommended
    }
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

  const handleSubmit = () => {
    const now = new Date().toISOString();
    const designId = `design-${Date.now()}`;
    const finalDesignNumber = designNumber;

    const primaryImg = images.find((i) => i.isPrimary)?.url || images[0]?.url || '';
    const allImgs = images.map((i) => i.url);

    let physicalSkuIndex = 0;
    const builtSkus: Sku[] = skus.flatMap((s, groupIdx) => {
      const pieces = Math.max(1, Math.min(100, parseInt(s.pieces, 10) || 1));
      return Array.from({ length: pieces }, (_, pieceIdx) => {
        physicalSkuIndex += 1;
        const numbering = getSettings().numbering;
        const skuNumber = `${finalDesignNumber}-${String(physicalSkuIndex).padStart(numbering.skuPadding, '0')}`;
        return {
          id: `sku-${Date.now()}-${groupIdx}-${pieceIdx}`,
          skuNumber,
          designId,
          designNumber: finalDesignNumber,
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
          semiWholesaleLabour: parseFloat(s.semiWholesaleLabour || s.wholesaleLabour || s.retailLabour || s.labour) || 0,
          wholesaleLabour: parseFloat(s.wholesaleLabour || s.retailLabour || s.labour) || 0,
          status: 'In Stock' as SkuStatus,
          location: BUSINESS_LOCATION,
          barcode: `${numbering.barcodePrefix || 'BC'}-${skuNumber}`,
          createdAt: now,
          createdBy: 'Admin',
          notes: pieces > 1 ? `${s.notes || ''} Group ${groupIdx + 1}, piece ${pieceIdx + 1} of ${pieces}`.trim() : s.notes,
          sellingMethod: form.sellingMethod as 'By Weight' | 'Per Piece',
          purity: form.purity as import('@/lib/mockData').Purity,
          material: form.material as import('@/lib/mockData').Material,
          category: form.category,
          subcategory: form.subcategory,
        };
      });
    });

    const newDesign: Design = {
      id: designId,
      designNumber: finalDesignNumber,
      designName: form.designName,
      category: form.category,
      subcategory: form.subcategory,
      material: form.material as import('@/lib/mockData').Material,
      purity: form.purity as import('@/lib/mockData').Purity,
      sellingMethod: form.sellingMethod as 'By Weight' | 'Per Piece',
      description: form.description,
      notes: form.notes,
      tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      images: allImgs,
      primaryImage: primaryImg,
      skus: builtSkus,
      createdAt: now,
      createdBy: 'Admin',
      labour: parseFloat(skus[0]?.retailLabour || skus[0]?.labour) || 0,
      retailLabour: parseFloat(skus[0]?.retailLabour || skus[0]?.labour) || 0,
      semiWholesaleLabour: parseFloat(skus[0]?.semiWholesaleLabour || skus[0]?.wholesaleLabour || skus[0]?.retailLabour || skus[0]?.labour) || 0,
      wholesaleLabour: parseFloat(skus[0]?.wholesaleLabour || skus[0]?.retailLabour || skus[0]?.labour) || 0,
      piroi: parseFloat(skus[0]?.piroi) || 0,
    };

    try {
      addDesign(newDesign);
      setSavedDesignNumber(finalDesignNumber);
      setSavedSkuCount(builtSkus.length);
      setSubmitted(true);
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Unable to save this design.']);
    }
  };

  const handleReset = () => {
    setStep(1);
    setImages([]);
    setForm({ designName: '', category: '', subcategory: '', material: '', purity: '', sellingMethod: '', description: '', tags: '', notes: '' });
    setSkus([{ id: `sku-init-${Date.now()}`, pieces: '1', grossWeight: '', originalNetWeight: '', customerNetWeight: '', stones: '', stoneWeight: '', kundan: '', kundanWeight: '', piroi: '', labour: '', retailLabour: '', semiWholesaleLabour: '', wholesaleLabour: '', notes: '' }]);
    setSubmitted(false);
    setErrors([]);
    setSavedDesignNumber('');
    setSavedSkuCount(0);
  };

  if (submitted) {
    return (
      <div className="max-w-2xl mx-auto">
        <SuccessScreen
          designNumber={savedDesignNumber || designNumber}
          skuCount={savedSkuCount}
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
          className="w-9 h-9 rounded-xl border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Add New Design</h1>
          <p className="text-sm text-muted-foreground">Create a new jewellery design and generate physical SKUs</p>
        </div>
      </div>

      {/* Step Indicator */}
      <StepIndicator step={step} />

      {/* Step Content */}
      <div className="bg-card border border-border rounded-2xl p-6 shadow-sm">
        {step === 1 && (
          <ImageUploadStep images={images} onImagesChange={setImages} />
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
            skus={skus}
            onSkusChange={setSkus}
          />
        )}

        {/* Validation Errors */}
        {errors.length > 0 && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl">
            {errors.map((e, i) => (
              <p key={i} className="text-sm text-red-600 font-medium">{e}</p>
            ))}
          </div>
        )}

        {/* Navigation Buttons */}
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-border">
          <button
            type="button"
            onClick={handleBack}
            disabled={step === 1}
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
              className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all"
            >
              Continue
              <ChevronRight size={16} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              className="flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold hover:bg-primary/90 transition-all shadow-md"
            >
              <CheckCircle2 size={16} />
              Save Design & SKUs
            </button>
          )}
        </div>
      </div>

      {/* Step 1 skip note */}
      {step === 1 && (
        <p className="text-center text-xs text-muted-foreground mt-3">
          Images are optional — you can add them later from the Design Detail page.
        </p>
      )}
    </div>
  );
}
