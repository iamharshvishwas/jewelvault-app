'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { getDesigns, removeSku, upsertDesign } from '@/lib/designStore';
import type { Design, Material, Purity, SellingMethod, Sku, SkuStatus } from '@/lib/mockData';
import { getCategories, getSubcategories } from '@/lib/catalogStore';

const STATUSES: SkuStatus[] = ['In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived'];
const MATERIALS: Material[] = ['Gold', 'Silver'];
const SELLING_METHODS: SellingMethod[] = ['By Weight', 'Per Piece'];
const LOCATIONS = ['Main Showroom', 'Jaishri Vault', 'Workshop', 'Exhibition'];

const numberValue = (value: string) => (value.trim() === '' ? 0 : Number(value));

function rateLabels(sellingMethod: SellingMethod) {
  const isPerPiece = sellingMethod === 'Per Piece';
  return {
    rateWord: isPerPiece ? 'Rate' : 'Labour',
    rateUnit: isPerPiece ? '₹/piece' : '₹/g',
  };
}

export default function EditStockClient() {
  const [design, setDesign] = useState<Design | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const found = getDesigns().find((item) => item.id === id) || getDesigns()[0] || null;
    setDesign(found ? structuredClone(found) : null);
  }, []);

  if (!design) {
    return (
      <div className="jewel-card p-8 text-center">
        <h1 className="text-xl font-bold">No Stock Found</h1>
        <Link href="/inventory-management" className="btn-primary mt-4 inline-flex">Back to Inventory</Link>
      </div>
    );
  }

  const updateDesign = <K extends keyof Design>(key: K, value: Design[K]) => {
    setSaved(false);
    setDesign((current) => (current ? { ...current, [key]: value } : current));
  };

  const updateSku = <K extends keyof Sku>(skuId: string, key: K, value: Sku[K]) => {
    setSaved(false);
    setDesign((current) => {
      if (!current) return current;
      return {
        ...current,
        skus: current.skus.map((sku) => (sku.id === skuId ? { ...sku, [key]: value } : sku)),
      };
    });
  };

  const save = () => {
    upsertDesign(design);
    setSaved(true);
  };

  const deleteSku = (sku: Sku) => {
    const message = design.skus.length === 1
      ? `Delete ${sku.skuNumber}? This is the last SKU, so the full design will also be removed.`
      : `Delete SKU ${sku.skuNumber}? This cannot be undone.`;
    if (!window.confirm(message)) return;

    const result = removeSku(sku.id);
    if (!result.removed) {
      alert('SKU was not found in saved stock.');
      return;
    }

    if (result.removedDesignId) {
      setDesign(null);
      window.location.href = '/inventory-management';
      return;
    }

    setSaved(false);
    setNotice(`${sku.skuNumber} deleted from stock.`);
    setDesign((current) => current ? { ...current, skus: current.skus.filter((item) => item.id !== sku.id) } : current);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/inventory-management" className="btn-secondary py-2 mb-3 inline-flex">
            <ArrowLeft size={15} />
            Back
          </Link>
          <h1 className="text-2xl font-bold text-foreground">Edit Existing Stock</h1>
          <p className="text-sm text-muted-foreground">{design.designNumber}</p>
        </div>
        <button onClick={save} className="btn-primary py-2">
          <Save size={15} />
          Save Changes
        </button>
      </div>

      {saved && <div className="jewel-card p-3 bg-emerald-50 border-emerald-200 text-sm font-semibold text-emerald-700">Stock saved.</div>}
      {notice && <div className="jewel-card p-3 bg-amber-50 border-amber-200 text-sm font-semibold text-amber-700">{notice}</div>}

      <section className="jewel-card p-4">
        <h2 className="text-sm font-semibold mb-3">Design Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-xs font-semibold">Design Name<input className="input-field mt-1" value={design.designName} onChange={(e) => updateDesign('designName', e.target.value)} /></label>
          <label className="text-xs font-semibold">Category<select className="input-field mt-1" value={design.category} onChange={(e) => updateDesign('category', e.target.value)}>
            {getCategories().map((category) => <option key={category}>{category}</option>)}
          </select></label>
          <label className="text-xs font-semibold">Subcategory<select className="input-field mt-1" value={design.subcategory} onChange={(e) => updateDesign('subcategory', e.target.value)}>
            <option value="">None</option>
            {getSubcategories(design.category).map((subcategory) => <option key={subcategory}>{subcategory}</option>)}
          </select></label>
          <label className="text-xs font-semibold">Material<select className="input-field mt-1" value={design.material} onChange={(e) => updateDesign('material', e.target.value as Material)}>
            {MATERIALS.map((material) => <option key={material}>{material}</option>)}
          </select></label>
          <label className="text-xs font-semibold">Purity<input className="input-field mt-1" value={design.purity} onChange={(e) => updateDesign('purity', e.target.value as Purity)} /></label>
          <label className="text-xs font-semibold">Selling Method<select className="input-field mt-1" value={design.sellingMethod} onChange={(e) => updateDesign('sellingMethod', e.target.value as SellingMethod)}>
            {SELLING_METHODS.map((method) => <option key={method}>{method}</option>)}
          </select></label>
          <label className="text-xs font-semibold md:col-span-3">Description<textarea className="input-field mt-1" value={design.description} onChange={(e) => updateDesign('description', e.target.value)} /></label>
        </div>
      </section>

      <section className="jewel-card p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-semibold">Physical SKUs</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Edit the same SKU details used while creating stock, plus live status and location.</p>
          </div>
          <span className="text-xs font-semibold text-muted-foreground">{design.skus.length} SKU{design.skus.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="space-y-4">
          {design.skus.map((sku) => {
            const labels = rateLabels(sku.sellingMethod);
            return (
              <div key={sku.id} className="rounded-xl border border-border bg-muted/10 overflow-hidden">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 px-4 py-3 bg-muted/40 border-b border-border">
                  <div>
                    <p className="font-mono text-sm font-bold text-primary">{sku.skuNumber}</p>
                    <p className="text-xs text-muted-foreground">{sku.material} {sku.purity} · {sku.sellingMethod} · {sku.barcode}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select className="input-field text-xs w-36" value={sku.status} onChange={(e) => updateSku(sku.id, 'status', e.target.value as SkuStatus)}>
                      {STATUSES.map((status) => <option key={status}>{status}</option>)}
                    </select>
                    <select className="input-field text-xs w-40" value={sku.location} onChange={(e) => updateSku(sku.id, 'location', e.target.value)}>
                      {LOCATIONS.map((location) => <option key={location}>{location}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => deleteSku(sku)}
                      className="inline-flex items-center gap-1 rounded-sm border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      <Trash2 size={13} />
                      Delete SKU
                    </button>
                  </div>
                </div>

                <div className="p-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                  <EditNumber label="Gross Weight (g)" value={sku.grossWeight} step="0.001" onChange={(value) => updateSku(sku.id, 'grossWeight', value)} />
                  <EditNumber label="Original Net Wt (g)" value={sku.originalNetWeight} step="0.001" privateField onChange={(value) => updateSku(sku.id, 'originalNetWeight', value)} />
                  <EditNumber label="Customer Net Wt (g)" value={sku.customerNetWeight} step="0.001" onChange={(value) => updateSku(sku.id, 'customerNetWeight', value)} />
                  <EditNumber label="Piroi (₹)" value={sku.piroi} step="0.01" onChange={(value) => updateSku(sku.id, 'piroi', value)} />
                  <EditNumber label="Stones (#)" value={sku.stones} step="1" onChange={(value) => updateSku(sku.id, 'stones', value)} />
                  <EditNumber label="Stone Weight (g)" value={sku.stoneWeight} step="0.001" onChange={(value) => updateSku(sku.id, 'stoneWeight', value)} />
                  <EditNumber label="Kundan (#)" value={sku.kundan} step="1" onChange={(value) => updateSku(sku.id, 'kundan', value)} />
                  <EditNumber label="Kundan Weight (g)" value={sku.kundanWeight} step="0.001" onChange={(value) => updateSku(sku.id, 'kundanWeight', value)} />
                  <EditNumber label={`Retail ${labels.rateWord} (${labels.rateUnit})`} value={sku.retailLabour ?? sku.labour} step="0.01" onChange={(value) => { updateSku(sku.id, 'retailLabour', value); updateSku(sku.id, 'labour', value); }} />
                  <EditNumber label={`Semi-Wholesale ${labels.rateWord} (${labels.rateUnit})`} value={sku.semiWholesaleLabour ?? sku.wholesaleLabour ?? sku.retailLabour ?? sku.labour} step="0.01" onChange={(value) => updateSku(sku.id, 'semiWholesaleLabour', value)} />
                  <EditNumber label={`Wholesale ${labels.rateWord} (${labels.rateUnit})`} value={sku.wholesaleLabour ?? sku.labour} step="0.01" onChange={(value) => updateSku(sku.id, 'wholesaleLabour', value)} />
                  <label className="col-span-2 md:col-span-3 xl:col-span-1 text-xs font-semibold text-muted-foreground">
                    Remarks
                    <input
                      className="input-field mt-1 text-xs"
                      value={sku.notes}
                      onChange={(e) => updateSku(sku.id, 'notes', e.target.value)}
                      placeholder="Optional remarks..."
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function EditNumber({
  label,
  value,
  step,
  privateField,
  onChange,
}: {
  label: string;
  value: number;
  step: string;
  privateField?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`text-xs font-semibold ${privateField ? 'text-amber-600' : 'text-muted-foreground'}`}>
      {label}
      <input
        className={`input-field mt-1 text-sm font-tabular font-semibold ${privateField ? 'border-amber-200 bg-amber-50/30' : ''}`}
        type="number"
        step={step}
        min="0"
        value={value}
        onChange={(e) => onChange(numberValue(e.target.value))}
      />
    </label>
  );
}
