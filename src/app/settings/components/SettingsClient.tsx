'use client';

import React, { useState, useSyncExternalStore } from 'react';
import SaveButton from '@/components/ui/SaveButton';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import {
  createCategory,
  createSubcategory,
  getCategories,
  getCategoryPrefix,
  getSubcategories,
  removeSubcategory,
  renameSubcategory,
  suggestCategoryPrefix,
} from '@/lib/catalogStore';
import { getDesigns } from '@/lib/designStore';
import { getSettings, saveSettings, type AppSettings } from '@/lib/settingsStore';

// Settings (spec D3, C5 (a), SEC-04; task WEB05). Every section is one row of the shop's settings and is saved on its own with its own Save button: a value is sent when
// the person says so, not on each key press (the last write wins, so a half-typed value must never be what is stored). The categories and sub-categories are rows of their own
// (a new one is shown when the server has made it; a rename and a removal are shown at once). The people are the shop's logins, made and changed with the owner's admin tool,
// so the list is shown and not edited here (SEC-04). The daily metal rates are entered on the dashboard, one for each day and purity (D4).

const TABS = [
  ['materials', 'Materials & Purities'],
  ['categories', 'Categories'],
  ['custom-fields', 'Custom Fields'],
  ['tag-templates', 'Tag Templates'],
  ['invoice-settings', 'Estimate Settings'],
  ['taxes', 'Taxes'],
  ['users', 'Users & Permissions'],
  ['numbering', 'Numbering'],
  ['business', 'Business Settings'],
] as const;

type TabId = (typeof TABS)[number][0];

const textTypes = ['Text', 'Number', 'Date', 'Yes/No'] as const;
const appliesTo = ['Design', 'SKU', 'Customer'] as const;

/** The sections that are edited as a whole and saved with one button. (The lists, materials and custom fields, save at each Add.) */
type SectionKey = 'tagTemplate' | 'estimate' | 'taxes' | 'numbering' | 'business';
type Drafts = { [K in SectionKey]?: AppSettings[K] };

const noSubscription = () => () => {};
const readTabFromUrl = (): TabId | null => {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return TABS.some(([id]) => id === tab) ? (tab as TabId) : null;
};

const PREFIX_RULE = /^[A-Z0-9]{2,6}$/;

export default function SettingsClient() {
  // drawn again when a poll or a save changes what is in memory
  useRowCacheVersion('settings', 'daily-rates', 'categories', 'subcategories', 'users', 'skus');
  const settings = getSettings();
  const categories = getCategories();
  const urlTab = useSyncExternalStore(noSubscription, readTabFromUrl, () => null);
  const [pickedTab, setPickedTab] = useState<TabId | null>(null);
  const tab = pickedTab ?? urlTab ?? 'materials';
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [categoryPrefix, setCategoryPrefix] = useState<string | null>(null);
  const [pickedCategory, setPickedCategory] = useState('');
  const [subcategoryName, setSubcategoryName] = useState('');
  const [editingSubcategory, setEditingSubcategory] = useState('');
  const [editingSubcategoryValue, setEditingSubcategoryValue] = useState('');
  const [newMaterial, setNewMaterial] = useState('');
  const [newPurity, setNewPurity] = useState<Record<string, string>>({});
  const [fieldDraft, setFieldDraft] = useState({
    label: '',
    type: 'Text',
    appliesTo: 'SKU',
    required: false,
  });

  const selectedCategory = categories.includes(pickedCategory)
    ? pickedCategory
    : (categories[0] ?? '');
  const prefixShown = categoryPrefix ?? suggestCategoryPrefix(categoryName);
  const activeSkuCount = getDesigns()
    .flatMap((design) => design.skus)
    .filter((sku) => sku.status !== 'Archived').length;

  /** A section as the person sees it: their unsaved changes over what is saved. */
  const view = <K extends SectionKey>(key: K): AppSettings[K] =>
    (drafts[key] ?? settings[key]) as AppSettings[K];

  const setField = <K extends SectionKey>(key: K, field: keyof AppSettings[K], value: unknown) =>
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? settings[key]), [field]: value },
    }));

  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(''), 2200);
  };

  /** One save at a time (C6); the reason of a failure is shown, and nothing is shown as saved that is not. */
  const run = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setProblem('');
    try {
      await action();
      flash(success);
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to save.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveSection = (key: SectionKey, note: string) =>
    run(async () => {
      await saveSettings({ ...getSettings(), [key]: drafts[key] ?? getSettings()[key] });
      setDrafts((current) => ({ ...current, [key]: undefined }));
    }, note);

  const saveCategory = async () => {
    const prefix = prefixShown.trim().toUpperCase();
    if (!PREFIX_RULE.test(prefix)) {
      setProblem('The prefix must be 2 to 6 capital letters or digits, for example RING.');
      return;
    }
    let saved = '';
    const ok = await run(async () => {
      saved = await createCategory(categoryName, prefix);
    }, 'Category saved.');
    if (ok) {
      setPickedCategory(saved);
      setCategoryName('');
      setCategoryPrefix(null);
    }
  };

  const saveSubcategory = async () => {
    const ok = await run(
      () => createSubcategory(selectedCategory, subcategoryName),
      'Subcategory saved.'
    );
    if (ok) setSubcategoryName('');
  };

  const saveSubcategoryRename = async (oldName: string) => {
    const ok = await run(
      () => renameSubcategory(selectedCategory, oldName, editingSubcategoryValue),
      'Subcategory updated.'
    );
    if (ok) {
      setEditingSubcategory('');
      setEditingSubcategoryValue('');
    }
  };

  const deleteSubcategory = (name: string) => {
    if (!window.confirm(`Delete subcategory "${name}" from ${selectedCategory}?`)) return;
    void run(() => removeSubcategory(selectedCategory, name), 'Subcategory deleted.');
  };

  const addMaterial = async () => {
    const clean = newMaterial.trim();
    if (!clean) return;
    const current = getSettings();
    if (current.materials.some((material) => material.name.toLowerCase() === clean.toLowerCase())) {
      setProblem('Material already exists.');
      return;
    }
    const ok = await run(
      () =>
        saveSettings({
          ...current,
          materials: [...current.materials, { name: clean, purities: [] }],
        }),
      'Material saved.'
    );
    if (ok) setNewMaterial('');
  };

  const removeMaterial = (name: string) => {
    const current = getSettings();
    void run(
      () =>
        saveSettings({
          ...current,
          materials: current.materials.filter((item) => item.name !== name),
        }),
      'Material removed.'
    );
  };

  const addPurity = async (materialName: string) => {
    const clean = (newPurity[materialName] || '').trim();
    if (!clean) return;
    const current = getSettings();
    const materials = current.materials.map((material) =>
      material.name === materialName &&
      !material.purities.some((purity) => purity.toLowerCase() === clean.toLowerCase())
        ? { ...material, purities: [...material.purities, clean.toUpperCase()] }
        : material
    );
    const ok = await run(() => saveSettings({ ...current, materials }), 'Purity saved.');
    if (ok) setNewPurity((prev) => ({ ...prev, [materialName]: '' }));
  };

  const addCustomField = async () => {
    const clean = fieldDraft.label.trim();
    if (!clean) return;
    const current = getSettings();
    // the id is the label in lower case: nothing is made up, and two fields cannot have the same label
    const id = `cf-${clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}`;
    if (current.customFields.some((field) => field.id === id)) {
      setProblem('A custom field with that name already exists.');
      return;
    }
    const ok = await run(
      () =>
        saveSettings({
          ...current,
          customFields: [
            ...current.customFields,
            {
              id,
              label: clean,
              type: fieldDraft.type as AppSettings['customFields'][number]['type'],
              appliesTo: fieldDraft.appliesTo as AppSettings['customFields'][number]['appliesTo'],
              required: fieldDraft.required,
            },
          ],
        }),
      'Custom field saved.'
    );
    if (ok) setFieldDraft({ label: '', type: 'Text', appliesTo: 'SKU', required: false });
  };

  const input = 'input-field text-sm';
  const tagTemplate = view('tagTemplate');
  const estimate = view('estimate');
  const taxes = view('taxes');
  const numbering = view('numbering');
  const business = view('business');

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Working controls for Jaishri Gold Palace Pvt Ltd. Each section has its own Save button.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {message && (
            <span
              role="status"
              className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-sm px-3 py-2"
            >
              {message}
            </span>
          )}
        </div>
      </div>

      {problem && (
        <div
          role="alert"
          className="jewel-card p-3 bg-red-50 border-red-200 text-sm font-semibold text-red-700"
        >
          {problem}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setPickedTab(id);
              setProblem('');
              window.history.replaceState(null, '', `/settings?tab=${id}`);
            }}
            className={tab === id ? 'btn-primary py-2 text-xs' : 'btn-secondary py-2 text-xs'}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="jewel-card p-5">
        {tab === 'materials' && (
          <Panel
            title="Materials & Purities"
            description="Add metal types and purities used while creating stock. Labour remains per gram or per piece on each SKU."
          >
            <div className="grid md:grid-cols-2 gap-3">
              {settings.materials.map((material) => (
                <div key={material.name} className="border border-border rounded-sm p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <strong>{material.name}</strong>
                    <SaveButton
                      disabled={busy}
                      className="text-xs text-red-600"
                      onClick={() => removeMaterial(material.name)}
                    >
                      Remove
                    </SaveButton>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {material.purities.map((purity) => (
                      <span
                        key={purity}
                        className="px-2 py-1 rounded-sm bg-muted text-xs font-semibold"
                      >
                        {purity}
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      className={input}
                      value={newPurity[material.name] || ''}
                      onChange={(event) =>
                        setNewPurity((prev) => ({ ...prev, [material.name]: event.target.value }))
                      }
                      placeholder="Add purity e.g. 916"
                    />
                    <SaveButton
                      disabled={busy}
                      onClick={() => void addPurity(material.name)}
                      className="btn-secondary py-2 text-xs"
                    >
                      Add
                    </SaveButton>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 max-w-lg">
              <input
                className={input}
                value={newMaterial}
                onChange={(event) => setNewMaterial(event.target.value)}
                placeholder="New material name"
              />
              <SaveButton
                disabled={busy}
                onClick={() => void addMaterial()}
                className="btn-primary py-2"
              >
                Save Material
              </SaveButton>
            </div>
          </Panel>
        )}

        {tab === 'categories' && (
          <Panel
            title="Categories"
            description="Add article categories and set the prefix used for design and SKU numbering. A prefix is chosen when the category is made and does not change, because the numbers already issued carry it."
          >
            <div className="flex gap-2 max-w-xl">
              <input
                className={input}
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="Add category"
              />
              <input
                className={`${input} w-28 uppercase`}
                aria-label="Prefix of the new category"
                value={prefixShown}
                maxLength={6}
                onChange={(event) =>
                  setCategoryPrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                }
                placeholder="Prefix"
              />
              <SaveButton
                disabled={busy}
                onClick={() => void saveCategory()}
                className="btn-primary"
              >
                Save
              </SaveButton>
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
              {categories.map((category) => (
                <div
                  key={category}
                  className="flex items-center justify-between gap-3 border border-border rounded-sm px-3 py-2"
                >
                  <span className="text-sm font-semibold">{category}</span>
                  <span className="text-xs font-mono text-muted-foreground">
                    {getCategoryPrefix(category)}
                  </span>
                </div>
              ))}
            </div>
            <div className="border-t border-border pt-4 space-y-3">
              <div>
                <h3 className="text-sm font-bold">Subcategories</h3>
                <p className="text-xs text-muted-foreground">
                  Defaults are Kundan, Casting, Jadau and Handmade.
                </p>
              </div>
              <div className="grid md:grid-cols-[260px_1fr_auto] gap-2 items-end">
                <label className="block">
                  <span className="text-xs font-semibold text-muted-foreground">Category</span>
                  <select
                    aria-label="Category of the sub-categories"
                    className={`${input} mt-1`}
                    value={selectedCategory}
                    onChange={(event) => setPickedCategory(event.target.value)}
                  >
                    {categories.map((category) => (
                      <option key={`subcat-cat-${category}`}>{category}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-muted-foreground">
                    New subcategory
                  </span>
                  <input
                    className={`${input} mt-1`}
                    value={subcategoryName}
                    onChange={(event) => setSubcategoryName(event.target.value)}
                    placeholder="e.g. Antique, Bridal, Daily Wear"
                  />
                </label>
                <SaveButton
                  disabled={busy}
                  onClick={() => void saveSubcategory()}
                  className="btn-primary py-2"
                >
                  Add Subcategory
                </SaveButton>
              </div>

              <div className="space-y-2">
                {getSubcategories(selectedCategory).map((subcategory) => (
                  <div
                    key={`${selectedCategory}-${subcategory}`}
                    className="flex items-center gap-2 border border-border rounded-sm px-3 py-2"
                  >
                    {editingSubcategory === subcategory ? (
                      <input
                        className={`${input} flex-1`}
                        value={editingSubcategoryValue}
                        onChange={(event) => setEditingSubcategoryValue(event.target.value)}
                      />
                    ) : (
                      <span className="flex-1 text-sm font-semibold">{subcategory}</span>
                    )}
                    {editingSubcategory === subcategory ? (
                      <SaveButton
                        disabled={busy}
                        onClick={() => void saveSubcategoryRename(subcategory)}
                        className="btn-primary py-1.5 text-xs"
                      >
                        Save
                      </SaveButton>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingSubcategory(subcategory);
                          setEditingSubcategoryValue(subcategory);
                        }}
                        className="btn-secondary py-1.5 text-xs"
                      >
                        Edit
                      </button>
                    )}
                    <SaveButton
                      disabled={busy}
                      onClick={() => deleteSubcategory(subcategory)}
                      className="text-xs text-red-600 border border-red-200 rounded-sm px-3 py-1.5 hover:bg-red-50"
                    >
                      Delete
                    </SaveButton>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        )}

        {tab === 'custom-fields' && (
          <Panel
            title="Custom Fields"
            description="Create extra fields for internal tracking. They are saved with the shop's settings and ready for use in stock/customer forms."
          >
            <div className="grid md:grid-cols-4 gap-2">
              <input
                className={input}
                value={fieldDraft.label}
                onChange={(event) =>
                  setFieldDraft((prev) => ({ ...prev, label: event.target.value }))
                }
                placeholder="Field label"
              />
              <select
                className={input}
                value={fieldDraft.type}
                onChange={(event) =>
                  setFieldDraft((prev) => ({ ...prev, type: event.target.value }))
                }
              >
                {textTypes.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
              <select
                className={input}
                value={fieldDraft.appliesTo}
                onChange={(event) =>
                  setFieldDraft((prev) => ({ ...prev, appliesTo: event.target.value }))
                }
              >
                {appliesTo.map((target) => (
                  <option key={target}>{target}</option>
                ))}
              </select>
              <SaveButton
                disabled={busy}
                onClick={() => void addCustomField()}
                className="btn-primary"
              >
                Add Field
              </SaveButton>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={fieldDraft.required}
                onChange={(event) =>
                  setFieldDraft((prev) => ({ ...prev, required: event.target.checked }))
                }
              />
              Required field
            </label>
            <Table
              rows={settings.customFields.map((field) => [
                field.label,
                field.type,
                field.appliesTo,
                field.required ? 'Required' : 'Optional',
              ])}
              empty="No custom fields added."
            />
          </Panel>
        )}

        {tab === 'tag-templates' && (
          <Panel
            title="Tag Templates"
            description={`These values control /print-tags. Current active stock: ${activeSkuCount} SKUs.`}
          >
            <div className="grid md:grid-cols-3 gap-3">
              <NumberField
                label="Width (mm)"
                value={tagTemplate.widthMm}
                onChange={(value) => setField('tagTemplate', 'widthMm', value)}
              />
              <NumberField
                label="Height (mm)"
                value={tagTemplate.heightMm}
                onChange={(value) => setField('tagTemplate', 'heightMm', value)}
              />
              <NumberField
                label="Copies per SKU"
                value={tagTemplate.copiesPerSku}
                onChange={(value) => setField('tagTemplate', 'copiesPerSku', Math.max(1, value))}
              />
              <NumberField
                label="Font size"
                value={tagTemplate.fontSize}
                onChange={(value) => setField('tagTemplate', 'fontSize', value)}
              />
              <NumberField
                label="Barcode height (mm)"
                value={tagTemplate.barcodeHeightMm}
                onChange={(value) => setField('tagTemplate', 'barcodeHeightMm', value)}
              />
            </div>
            <CheckList
              values={[
                ['showBusinessName', 'Show business name'],
                ['showDesignNumber', 'Show design number'],
                ['showCategory', 'Show category'],
                ['showMaterial', 'Show material'],
                ['showGrossWeight', 'Show gross weight'],
                ['showCustomerNetWeight', 'Show customer net weight'],
                ['showPiroi', 'Show piroi'],
              ]}
              state={tagTemplate}
              onChange={(key, value) => setField('tagTemplate', key, value)}
            />
            <SectionSave
              busy={busy}
              onSave={() => void saveSection('tagTemplate', 'Tag template saved.')}
            >
              Save Tag Template
            </SectionSave>
          </Panel>
        )}

        {tab === 'invoice-settings' && (
          <Panel
            title="Estimate Settings"
            description="Estimate defaults used by the sale page. GST stays zero because the customer document is an estimate only. The metal rates are entered for each day on the dashboard (Daily Metal Rates)."
          >
            <div className="grid md:grid-cols-2 gap-3">
              <TextField
                label="Estimate prefix"
                value={estimate.prefix}
                onChange={(value) => setField('estimate', 'prefix', value.toUpperCase())}
              />
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={estimate.roundOff}
                  onChange={(event) => setField('estimate', 'roundOff', event.target.checked)}
                />
                Round off final estimate total
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-semibold text-muted-foreground">Footer note</span>
              <textarea
                className={`${input} mt-1 min-h-24`}
                value={estimate.footerNote}
                onChange={(event) => setField('estimate', 'footerNote', event.target.value)}
              />
            </label>
            <SectionSave
              busy={busy}
              onSave={() => void saveSection('estimate', 'Estimate settings saved.')}
            >
              Save Estimate Settings
            </SectionSave>
          </Panel>
        )}

        {tab === 'taxes' && (
          <Panel
            title="Taxes"
            description="Estimates are kept GST-free. You can store business GST details, but estimate tax remains zero."
          >
            <div className="grid md:grid-cols-3 gap-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={taxes.gstEnabled}
                  onChange={(event) => setField('taxes', 'gstEnabled', event.target.checked)}
                />
                GST registered business
              </label>
              <NumberField
                label="Business GST percent"
                value={taxes.gstPercent}
                onChange={(value) => setField('taxes', 'gstPercent', value)}
              />
              <TextField label="Estimate GST" value="0%" onChange={() => undefined} disabled />
            </div>
            <SectionSave busy={busy} onSave={() => void saveSection('taxes', 'Taxes saved.')}>
              Save Taxes
            </SectionSave>
          </Panel>
        )}

        {tab === 'users' && (
          <Panel
            title="Users & Permissions"
            description="The people who can sign in. Logins are made, changed and switched off by the owner with the admin tool; this list shows who they are and what each role may do."
          >
            <div className="space-y-2">
              {settings.users.map((user) => (
                <div
                  key={user.id}
                  className="grid md:grid-cols-[1fr_150px_160px_130px_100px] gap-2 items-center border border-border rounded-sm p-3"
                >
                  <strong className="text-sm">{user.name}</strong>
                  <span className="text-xs text-muted-foreground">{user.role}</span>
                  <span className="text-xs">
                    {user.canSeeOriginalWeight ? 'Sees original weight' : 'No original weight'}
                  </span>
                  <span className="text-xs">
                    {user.canEditStock ? 'Edits stock' : 'Cannot edit stock'}
                  </span>
                  <span className="text-xs">{user.active ? 'Active' : 'Switched off'}</span>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {tab === 'numbering' && (
          <Panel
            title="Numbering"
            description="Set padding and the barcode prefix used for newly created designs and SKUs. The numbers themselves are given by the server when a design is saved."
          >
            <div className="grid md:grid-cols-3 gap-3">
              <NumberField
                label="Design number padding"
                value={numbering.designPadding}
                onChange={(value) => setField('numbering', 'designPadding', value)}
              />
              <NumberField
                label="SKU serial padding"
                value={numbering.skuPadding}
                onChange={(value) => setField('numbering', 'skuPadding', value)}
              />
              <TextField
                label="Barcode prefix"
                value={numbering.barcodePrefix}
                onChange={(value) => setField('numbering', 'barcodePrefix', value.toUpperCase())}
              />
            </div>
            <SectionSave
              busy={busy}
              onSave={() => void saveSection('numbering', 'Numbering saved.')}
            >
              Save Numbering
            </SectionSave>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
              {categories.map((category) => (
                <div
                  key={`num-${category}`}
                  className="flex items-center justify-between gap-3 border border-border rounded-sm px-3 py-2"
                >
                  <span className="text-sm font-semibold">{category}</span>
                  <span className="text-xs font-mono text-muted-foreground">
                    {getCategoryPrefix(category)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {tab === 'business' && (
          <Panel
            title="Business Settings"
            description="Business details for print layouts and operational records."
          >
            <div className="grid md:grid-cols-2 gap-3">
              <TextField
                label="Legal name"
                value={business.legalName}
                onChange={(value) => setField('business', 'legalName', value)}
              />
              <TextField
                label="Display name"
                value={business.displayName}
                onChange={(value) => setField('business', 'displayName', value)}
              />
              <TextField
                label="Showroom / branch"
                value={business.location}
                onChange={(value) => setField('business', 'location', value)}
              />
              <TextField
                label="Owner / admin name"
                value={business.ownerName}
                onChange={(value) => setField('business', 'ownerName', value)}
              />
              <TextField
                label="Phone"
                value={business.phone}
                onChange={(value) => setField('business', 'phone', value)}
              />
              <TextField
                label="GSTIN"
                value={business.gstin}
                onChange={(value) => setField('business', 'gstin', value.toUpperCase())}
              />
            </div>
            <TextField
              label="Tagline"
              value={business.tagline}
              onChange={(value) => setField('business', 'tagline', value)}
            />
            <label className="block">
              <span className="text-xs font-semibold text-muted-foreground">Address</span>
              <textarea
                className={`${input} mt-1 min-h-24`}
                value={business.address}
                onChange={(event) => setField('business', 'address', event.target.value)}
              />
            </label>
            <SectionSave
              busy={busy}
              onSave={() => void saveSection('business', 'Business settings saved.')}
            >
              Save Business Settings
            </SectionSave>
          </Panel>
        )}
      </section>
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** The one Save button of a section (C6, C7). */
function SectionSave({
  busy,
  onSave,
  children,
}: {
  busy: boolean;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <SaveButton disabled={busy} onClick={onSave} className="btn-primary py-2">
        {children}
      </SaveButton>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <input
        className="input-field text-sm mt-1"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <input
        className="input-field text-sm mt-1"
        type="number"
        value={value}
        min={0}
        onChange={(event) => onChange(parseFloat(event.target.value) || 0)}
      />
    </label>
  );
}

function CheckList<T extends object>({
  values,
  state,
  onChange,
}: {
  values: [keyof T, string][];
  state: T;
  onChange: (key: keyof T, value: boolean) => void;
}) {
  return (
    <div className="grid md:grid-cols-2 gap-2">
      {values.map(([key, label]) => (
        <label key={String(key)} className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={Boolean(state[key])}
            onChange={(event) => onChange(key, event.target.checked)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

function Table({ rows, empty }: { rows: string[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      {rows.map((row, index) => (
        <div
          key={`${row.join('-')}-${index}`}
          className="grid grid-cols-4 gap-2 px-3 py-2 text-sm border-b last:border-b-0 border-border"
        >
          {row.map((cell) => (
            <span key={`${index}-${cell}`}>{cell}</span>
          ))}
        </div>
      ))}
    </div>
  );
}
