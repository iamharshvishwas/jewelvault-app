'use client';

import React, { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Archive, ArrowLeft, Save } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { useSession } from '@/lib/authStore';
import { getCategories, getSubcategories } from '@/lib/catalogStore';
import { useSavingAllowed } from '@/lib/api/connection';
import { SaveError } from '@/lib/cache/edit';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { getDesigns, setSkuStatus, upsertDesign } from '@/lib/designStore';
import { getLocations } from '@/lib/settingsStore';
import type { Design, Material, Purity, SellingMethod, Sku, SkuStatus } from '@/lib/mockData';

// Edit Existing Stock (spec C5 (a), A5; task WEB05). The screen shows the design as it is in memory. The first change makes the person's working copy, and the design as
// it was at that moment is kept beside it: Save sends one write for each row that changed, with only the fields that changed and the stamp of THAT design, so a row that
// somebody else saved meanwhile is answered stale and reloaded, never overwritten (src/lib/designStore.ts, src/lib/cache/edit.ts). The owner-only weight is not an ordinary edit
// and is not changed here; a piece is never deleted (S7).
// WEB06: the status of a piece has its own step (X9 set_sku_status): choosing a status, or pressing Archive, is ONE call for that piece, and the piece shows the new status once
// the API has answered (a Sold piece cannot be changed, and any status can be refused). While there are unsaved changes the status cannot be changed, so that the stamp of
// the piece the changes were started from is still the one the API holds when Save sends them.

const STATUSES: SkuStatus[] = [
  'In Stock',
  'Reserved',
  'On Approval',
  'Sold',
  'Returned',
  'Repair',
  'Transferred',
  'Missing',
  'Damaged',
  'Archived',
];
const MATERIALS: Material[] = ['Gold', 'Silver'];
const SELLING_METHODS: SellingMethod[] = ['By Weight', 'Per Piece'];

const numberValue = (value: string) => (value.trim() === '' ? 0 : Number(value));

function rateLabels(sellingMethod: SellingMethod) {
  const isPerPiece = sellingMethod === 'Per Piece';
  return {
    rateWord: isPerPiece ? 'Rate' : 'Labour',
    rateUnit: isPerPiece ? '₹/piece' : '₹/g',
  };
}

const noSubscription = () => () => {};
/** The `id` of the address, read when the page is drawn (the page is left and opened again for another design). */
const readIdFromUrl = () => new URLSearchParams(window.location.search).get('id');

interface WorkingCopy {
  /** The design as it was when the person started: what the write is compared with, and whose stamps it sends. */
  base: Design;
  /** The person's copy. */
  draft: Design;
}

export default function EditStockClient() {
  const { role } = useSession();
  const isOwner = role === 'owner';
  const savingAllowed = useSavingAllowed();
  // drawn again when a poll or an edit changes what is in memory
  useRowCacheVersion('designs', 'skus', 'sku-private', 'categories', 'subcategories', 'settings');
  const wantedId = useSyncExternalStore(noSubscription, readIdFromUrl, () => null);
  const designs = getDesigns();
  const stored = designs.find((item) => item.id === wantedId) || designs[0] || null;

  const [work, setWork] = useState<WorkingCopy | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  /** The piece whose status is on its way (X9). */
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const design = work?.draft ?? stored;

  if (!design) {
    return (
      <div className="jewel-card p-8 text-center">
        <h1 className="text-xl font-bold">No Stock Found</h1>
        <Link href="/inventory-management" className="btn-primary mt-4 inline-flex">
          Back to Inventory
        </Link>
      </div>
    );
  }

  /** Changes the person's working copy; the first change takes the design as it is now as its starting point. */
  const edit = (change: (draft: Design) => Design) => {
    setSaved('');
    setNotice('');
    setWork((current) => {
      const from = current?.base ?? stored;
      if (!from) return current;
      return { base: from, draft: change(current?.draft ?? structuredClone(from)) };
    });
  };

  const updateDesign = <K extends keyof Design>(key: K, value: Design[K]) =>
    edit((draft) => ({ ...draft, [key]: value }));

  const updateCategory = (category: string) =>
    edit((draft) => ({
      ...draft,
      category,
      // a sub-category belongs to one category: keep it only if the new category has it
      subcategory: getSubcategories(category).includes(draft.subcategory) ? draft.subcategory : '',
    }));

  const updateSku = <K extends keyof Sku>(skuId: string, key: K, value: Sku[K]) =>
    edit((draft) => ({
      ...draft,
      skus: draft.skus.map((sku) => (sku.id === skuId ? { ...sku, [key]: value } : sku)),
    }));

  const save = async () => {
    if (!work || saving) return;
    setSaving(true);
    setSaved('');
    setProblem('');
    try {
      const written = await upsertDesign(work.draft, work.base);
      setWork(null); // what is in memory now is what the server returned
      setSaved(written > 0 ? 'Stock saved.' : 'Nothing to save.');
    } catch (error) {
      if (error instanceof SaveError) {
        // somebody else saved first (the latest is in memory), or part of it was saved: show what is saved, so that nothing is saved on top of an old copy
        if (error.stale || error.saved > 0) setWork(null);
        setProblem(
          error.saved > 0
            ? `${error.saved} ${error.saved === 1 ? 'row was' : 'rows were'} saved. ${error.message} The rest was not saved: check the details and make the change again.`
            : error.message
        );
      } else {
        setProblem(error instanceof Error ? error.message : 'Unable to save the stock.');
      }
    } finally {
      setSaving(false);
    }
  };

  /** X9: one call for the piece, shown after the API has answered. A refusal says why in the API's own plain words. */
  const changeStatus = async (sku: Sku, status: SkuStatus) => {
    if (statusBusy !== null || status === sku.status) return;
    setStatusBusy(sku.id);
    setSaved('');
    setProblem('');
    setNotice('');
    try {
      await setSkuStatus([sku.id], status);
      setSaved(`${sku.skuNumber} is now ${status}.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to change the status.');
    } finally {
      setStatusBusy(null);
    }
  };

  const archiveSku = (sku: Sku) => {
    if (
      !window.confirm(
        `Archive ${sku.skuNumber}? It leaves the stock list, and its record is kept. You can bring it back by choosing another status.`
      )
    )
      return;
    void changeStatus(sku, 'Archived');
  };

  // the places a piece can be: the setting of the shop, and the one the piece has now if that is not on the list
  const locationsFor = (current: string) => {
    const known = getLocations();
    return current === '' || known.includes(current) ? known : [...known, current];
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
        {/* C6, C7: off while a save runs, while nothing has changed, and while the banner "Offline" or "Waking up" shows */}
        <SaveButton onClick={save} disabled={saving || !work} className="btn-primary py-2">
          <Save size={15} />
          {saving ? 'Saving…' : 'Save Changes'}
        </SaveButton>
      </div>

      {saved && (
        <div
          role="status"
          className="jewel-card p-3 bg-emerald-50 border-emerald-200 text-sm font-semibold text-emerald-700"
        >
          {saved}
        </div>
      )}
      {problem && (
        <div
          role="alert"
          className="jewel-card p-3 bg-red-50 border-red-200 text-sm font-semibold text-red-700"
        >
          {problem}
        </div>
      )}
      {notice && (
        <div className="jewel-card p-3 bg-amber-50 border-amber-200 text-sm font-semibold text-amber-700">
          {notice}
        </div>
      )}

      <section className="jewel-card p-4">
        <h2 className="text-sm font-semibold mb-3">Design Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-xs font-semibold">
            Design Name
            <input
              className="input-field mt-1"
              value={design.designName}
              onChange={(e) => updateDesign('designName', e.target.value)}
            />
          </label>
          <label className="text-xs font-semibold">
            Category
            <select
              className="input-field mt-1"
              value={design.category}
              onChange={(e) => updateCategory(e.target.value)}
            >
              {getCategories().map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold">
            Subcategory
            <select
              className="input-field mt-1"
              value={design.subcategory}
              onChange={(e) => updateDesign('subcategory', e.target.value)}
            >
              <option value="">None</option>
              {getSubcategories(design.category).map((subcategory) => (
                <option key={subcategory}>{subcategory}</option>
              ))}
            </select>
          </label>
          {/* only the owner changes the material, the purity and the selling method of a design (A5) */}
          <label className="text-xs font-semibold">
            Material
            <select
              className="input-field mt-1"
              value={design.material}
              disabled={!isOwner}
              title={isOwner ? undefined : 'Only the owner can change this.'}
              onChange={(e) => updateDesign('material', e.target.value as Material)}
            >
              {MATERIALS.map((material) => (
                <option key={material}>{material}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold">
            Purity
            <input
              className="input-field mt-1"
              value={design.purity}
              disabled={!isOwner}
              title={isOwner ? undefined : 'Only the owner can change this.'}
              onChange={(e) => updateDesign('purity', e.target.value as Purity)}
            />
          </label>
          <label className="text-xs font-semibold">
            Selling Method
            <select
              className="input-field mt-1"
              value={design.sellingMethod}
              disabled={!isOwner}
              title={isOwner ? undefined : 'Only the owner can change this.'}
              onChange={(e) => updateDesign('sellingMethod', e.target.value as SellingMethod)}
            >
              {SELLING_METHODS.map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-semibold md:col-span-3">
            Description
            <textarea
              className="input-field mt-1"
              value={design.description}
              onChange={(e) => updateDesign('description', e.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="jewel-card p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-semibold">Physical SKUs</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Edit the same SKU details used while creating stock, plus location.
            </p>
          </div>
          <span className="text-xs font-semibold text-muted-foreground">
            {design.skus.length} SKU{design.skus.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="space-y-4">
          {design.skus.map((sku) => {
            const labels = rateLabels(sku.sellingMethod);
            return (
              <div
                key={sku.id}
                data-testid={`piece-${sku.skuNumber}`}
                className="rounded-xl border border-border bg-muted/10 overflow-hidden"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 px-4 py-3 bg-muted/40 border-b border-border">
                  <div>
                    <p className="font-mono text-sm font-bold text-primary">{sku.skuNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {sku.material} {sku.purity} · {sku.sellingMethod} · {sku.barcode}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* the status has a step of its own (X9): one call for this piece, shown when the API has answered. Sold is made by a bill and cannot be chosen. */}
                    <select
                      aria-label={`Status of ${sku.skuNumber}`}
                      className="input-field text-xs w-36"
                      value={sku.status}
                      disabled={
                        !savingAllowed ||
                        statusBusy !== null ||
                        work !== null ||
                        sku.status === 'Sold'
                      }
                      title={
                        sku.status === 'Sold'
                          ? 'A sold piece is changed by cancelling or re-issuing its bill.'
                          : work !== null
                            ? 'Save your changes first, then change the status.'
                            : undefined
                      }
                      onChange={(e) => void changeStatus(sku, e.target.value as SkuStatus)}
                    >
                      {STATUSES.filter((status) => status !== 'Sold' || sku.status === 'Sold').map(
                        (status) => (
                          <option key={status}>{status}</option>
                        )
                      )}
                    </select>
                    <select
                      aria-label={`Location of ${sku.skuNumber}`}
                      className="input-field text-xs w-40"
                      value={sku.location}
                      onChange={(e) => updateSku(sku.id, 'location', e.target.value)}
                    >
                      {sku.location === '' && <option value="">Not set</option>}
                      {locationsFor(sku.location).map((location) => (
                        <option key={location}>{location}</option>
                      ))}
                    </select>
                    {/* nothing is deleted (S7): a piece leaves the stock by being archived (X9) */}
                    {sku.status !== 'Sold' && sku.status !== 'Archived' && (
                      <SaveButton
                        type="button"
                        onClick={() => archiveSku(sku)}
                        disabled={statusBusy !== null || work !== null}
                        title={work !== null ? 'Save your changes first, then archive.' : undefined}
                        className="inline-flex items-center gap-1 rounded-sm border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        <Archive size={13} />
                        Archive
                      </SaveButton>
                    )}
                  </div>
                </div>

                <div className="p-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                  <EditNumber
                    label="Gross Weight (g)"
                    value={sku.grossWeight}
                    step="0.001"
                    onChange={(value) => updateSku(sku.id, 'grossWeight', value)}
                  />
                  {/* the owner's weight is the owner's alone, and is entered when the piece is made */}
                  {isOwner && (
                    <EditNumber
                      label="Original Net Wt (g)"
                      value={sku.originalNetWeight}
                      step="0.001"
                      privateField
                      readOnly
                      onChange={(value) => updateSku(sku.id, 'originalNetWeight', value)}
                    />
                  )}
                  <EditNumber
                    label="Customer Net Wt (g)"
                    value={sku.customerNetWeight}
                    step="0.001"
                    onChange={(value) => updateSku(sku.id, 'customerNetWeight', value)}
                  />
                  <EditNumber
                    label="Piroi (₹)"
                    value={sku.piroi}
                    step="0.01"
                    onChange={(value) => updateSku(sku.id, 'piroi', value)}
                  />
                  <EditNumber
                    label="Stones (#)"
                    value={sku.stones}
                    step="1"
                    onChange={(value) => updateSku(sku.id, 'stones', value)}
                  />
                  <EditNumber
                    label="Stone Weight (g)"
                    value={sku.stoneWeight}
                    step="0.001"
                    onChange={(value) => updateSku(sku.id, 'stoneWeight', value)}
                  />
                  <EditNumber
                    label="Kundan (#)"
                    value={sku.kundan}
                    step="1"
                    onChange={(value) => updateSku(sku.id, 'kundan', value)}
                  />
                  <EditNumber
                    label="Kundan Weight (g)"
                    value={sku.kundanWeight}
                    step="0.001"
                    onChange={(value) => updateSku(sku.id, 'kundanWeight', value)}
                  />
                  <EditNumber
                    label={`Retail ${labels.rateWord} (${labels.rateUnit})`}
                    value={sku.retailLabour ?? sku.labour}
                    step="0.01"
                    onChange={(value) => {
                      updateSku(sku.id, 'retailLabour', value);
                      updateSku(sku.id, 'labour', value);
                    }}
                  />
                  <EditNumber
                    label={`Semi-Wholesale ${labels.rateWord} (${labels.rateUnit})`}
                    value={
                      sku.semiWholesaleLabour ??
                      sku.wholesaleLabour ??
                      sku.retailLabour ??
                      sku.labour
                    }
                    step="0.01"
                    onChange={(value) => updateSku(sku.id, 'semiWholesaleLabour', value)}
                  />
                  <EditNumber
                    label={`Wholesale ${labels.rateWord} (${labels.rateUnit})`}
                    value={sku.wholesaleLabour ?? sku.labour}
                    step="0.01"
                    onChange={(value) => updateSku(sku.id, 'wholesaleLabour', value)}
                  />
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
  readOnly,
  onChange,
}: {
  label: string;
  value: number;
  step: string;
  privateField?: boolean;
  readOnly?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label
      className={`text-xs font-semibold ${privateField ? 'text-amber-600' : 'text-muted-foreground'}`}
    >
      {label}
      <input
        className={`input-field mt-1 text-sm font-tabular font-semibold ${privateField ? 'border-amber-200 bg-amber-50/30' : ''}`}
        type="number"
        step={step}
        min="0"
        value={value}
        readOnly={readOnly}
        title={readOnly ? 'Entered when the piece is created.' : undefined}
        onChange={(e) => onChange(numberValue(e.target.value))}
      />
    </label>
  );
}
