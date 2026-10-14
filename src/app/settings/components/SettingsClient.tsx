'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { addCategory, addSubcategory, clearAllSubcategories, getCategories, getSubcategories, removeSubcategory, renameSubcategory } from '@/lib/catalogStore';
import { getDesigns } from '@/lib/designStore';
import { getSettings, resetSettings, saveSettings, type AppSettings } from '@/lib/settingsStore';

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
const roles = ['Owner', 'Admin', 'Billing Staff', 'Inventory Staff'] as const;

export default function SettingsClient() {
  const [tab, setTab] = useState<TabId>('materials');
  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  const [categories, setCategories] = useState(() => getCategories());
  const [message, setMessage] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(() => getCategories()[0] || '');
  const [subcategoryName, setSubcategoryName] = useState('');
  const [editingSubcategory, setEditingSubcategory] = useState('');
  const [editingSubcategoryValue, setEditingSubcategoryValue] = useState('');
  const [newMaterial, setNewMaterial] = useState('');
  const [newPurity, setNewPurity] = useState<Record<string, string>>({});
  const [fieldDraft, setFieldDraft] = useState({ label: '', type: 'Text', appliesTo: 'SKU', required: false });
  const [userDraft, setUserDraft] = useState({ name: '', role: 'Billing Staff' });

  useEffect(() => {
    const initialTab = new URLSearchParams(window.location.search).get('tab') as TabId | null;
    if (initialTab && TABS.some(([id]) => id === initialTab)) setTab(initialTab);
  }, []);

  const activeSkuCount = useMemo(
    () => getDesigns().flatMap((design) => design.skus).filter((sku) => sku.status !== 'Archived').length,
    []
  );

  const persist = (next: AppSettings, note = 'Settings saved.') => {
    setSettings(saveSettings(next));
    setMessage(note);
    window.setTimeout(() => setMessage(''), 2200);
  };

  const saveCategory = () => {
    try {
      const saved = addCategory(categoryName);
      const next = {
        ...settings,
        numbering: {
          ...settings.numbering,
          categoryPrefixes: {
            ...settings.numbering.categoryPrefixes,
            [saved]: settings.numbering.categoryPrefixes[saved] || saved.replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'DES',
          },
        },
      };
      setCategories(getCategories());
      setSelectedCategory(saved);
      setCategoryName('');
      persist(next, 'Category saved.');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to save category.');
    }
  };

  const refreshCategories = () => {
    const nextCategories = getCategories();
    setCategories(nextCategories);
    if (!selectedCategory && nextCategories[0]) setSelectedCategory(nextCategories[0]);
  };

  const saveSubcategory = () => {
    try {
      addSubcategory(selectedCategory, subcategoryName);
      setSubcategoryName('');
      refreshCategories();
      setMessage('Subcategory saved.');
      window.setTimeout(() => setMessage(''), 2200);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to save subcategory.');
    }
  };

  const saveSubcategoryRename = (oldName: string) => {
    try {
      renameSubcategory(selectedCategory, oldName, editingSubcategoryValue);
      setEditingSubcategory('');
      setEditingSubcategoryValue('');
      refreshCategories();
      setMessage('Subcategory updated.');
      window.setTimeout(() => setMessage(''), 2200);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to update subcategory.');
    }
  };

  const deleteSubcategory = (name: string) => {
    if (!window.confirm(`Delete subcategory "${name}" from ${selectedCategory}?`)) return;
    removeSubcategory(selectedCategory, name);
    refreshCategories();
    setMessage('Subcategory deleted.');
    window.setTimeout(() => setMessage(''), 2200);
  };

  const deleteAllSubcategories = () => {
    if (!window.confirm('Remove all subcategories from every category? You can add them again from Settings or Add Design.')) return;
    clearAllSubcategories();
    refreshCategories();
    setMessage('All subcategories removed.');
    window.setTimeout(() => setMessage(''), 2200);
  };

  const updatePrefix = (category: string, prefix: string) => {
    persist({
      ...settings,
      numbering: {
        ...settings.numbering,
        categoryPrefixes: {
          ...settings.numbering.categoryPrefixes,
          [category]: prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
        },
      },
    });
  };

  const addMaterial = () => {
    const clean = newMaterial.trim();
    if (!clean) return;
    if (settings.materials.some((material) => material.name.toLowerCase() === clean.toLowerCase())) {
      alert('Material already exists.');
      return;
    }
    persist({ ...settings, materials: [...settings.materials, { name: clean, purities: [] }] }, 'Material saved.');
    setNewMaterial('');
  };

  const addPurity = (materialName: string) => {
    const clean = (newPurity[materialName] || '').trim();
    if (!clean) return;
    const materials = settings.materials.map((material) =>
      material.name === materialName && !material.purities.some((purity) => purity.toLowerCase() === clean.toLowerCase())
        ? { ...material, purities: [...material.purities, clean.toUpperCase()] }
        : material
    );
    persist({ ...settings, materials }, 'Purity saved.');
    setNewPurity((prev) => ({ ...prev, [materialName]: '' }));
  };

  const addCustomField = () => {
    const clean = fieldDraft.label.trim();
    if (!clean) return;
    persist({
      ...settings,
      customFields: [
        ...settings.customFields,
        {
          id: `cf-${Date.now()}`,
          label: clean,
          type: fieldDraft.type as AppSettings['customFields'][number]['type'],
          appliesTo: fieldDraft.appliesTo as AppSettings['customFields'][number]['appliesTo'],
          required: fieldDraft.required,
        },
      ],
    }, 'Custom field saved.');
    setFieldDraft({ label: '', type: 'Text', appliesTo: 'SKU', required: false });
  };

  const addUser = () => {
    const clean = userDraft.name.trim();
    if (!clean) return;
    persist({
      ...settings,
      users: [
        ...settings.users,
        {
          id: `user-${Date.now()}`,
          name: clean,
          role: userDraft.role as AppSettings['users'][number]['role'],
          canSeeOriginalWeight: userDraft.role === 'Owner' || userDraft.role === 'Admin',
          canEditStock: userDraft.role !== 'Billing Staff',
          active: true,
        },
      ],
    }, 'User saved.');
    setUserDraft({ name: '', role: 'Billing Staff' });
  };

  const input = 'input-field text-sm';

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">Local working controls for Jaishri Gold Palace Pvt Ltd</p>
        </div>
        <div className="flex items-center gap-2">
          {message && <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-sm px-3 py-2">{message}</span>}
          <button onClick={() => persist(resetSettings(), 'Settings reset.')} className="btn-secondary py-2 text-xs">Reset Defaults</button>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
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
          <Panel title="Materials & Purities" description="Add metal types and purities used while creating stock. Labour remains per gram or per piece on each SKU.">
            <div className="grid md:grid-cols-2 gap-3">
              {settings.materials.map((material) => (
                <div key={material.name} className="border border-border rounded-sm p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <strong>{material.name}</strong>
                    <button
                      className="text-xs text-red-600"
                      onClick={() => persist({ ...settings, materials: settings.materials.filter((item) => item.name !== material.name) })}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {material.purities.map((purity) => <span key={purity} className="px-2 py-1 rounded-sm bg-muted text-xs font-semibold">{purity}</span>)}
                  </div>
                  <div className="flex gap-2">
                    <input className={input} value={newPurity[material.name] || ''} onChange={(event) => setNewPurity((prev) => ({ ...prev, [material.name]: event.target.value }))} placeholder="Add purity e.g. 916" />
                    <button onClick={() => addPurity(material.name)} className="btn-secondary py-2 text-xs">Add</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 max-w-lg">
              <input className={input} value={newMaterial} onChange={(event) => setNewMaterial(event.target.value)} placeholder="New material name" />
              <button onClick={addMaterial} className="btn-primary py-2">Save Material</button>
            </div>
          </Panel>
        )}

        {tab === 'categories' && (
          <Panel title="Categories" description="Add article categories and set the prefix used for design and SKU numbering.">
            <div className="flex gap-2 max-w-lg">
              <input className={input} value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Add category" />
              <button onClick={saveCategory} className="btn-primary">Save</button>
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
              {categories.map((category) => (
                <label key={category} className="flex items-center justify-between gap-3 border border-border rounded-sm px-3 py-2">
                  <span className="text-sm font-semibold">{category}</span>
                  <input className={`${input} w-24 uppercase`} value={settings.numbering.categoryPrefixes[category] || ''} onChange={(event) => updatePrefix(category, event.target.value)} />
                </label>
              ))}
            </div>
            <div className="border-t border-border pt-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold">Subcategories</h3>
                  <p className="text-xs text-muted-foreground">Defaults are Kundan, Casting, Jadau and Handmade.</p>
                </div>
                <button onClick={deleteAllSubcategories} className="text-xs text-red-600 border border-red-200 rounded-sm px-3 py-2 hover:bg-red-50">
                  Remove All Subcategories
                </button>
              </div>
              <div className="grid md:grid-cols-[260px_1fr_auto] gap-2 items-end">
                <label className="block">
                  <span className="text-xs font-semibold text-muted-foreground">Category</span>
                  <select className={`${input} mt-1`} value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
                    {categories.map((category) => <option key={`subcat-cat-${category}`}>{category}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-muted-foreground">New subcategory</span>
                  <input className={`${input} mt-1`} value={subcategoryName} onChange={(event) => setSubcategoryName(event.target.value)} placeholder="e.g. Antique, Bridal, Daily Wear" />
                </label>
                <button onClick={saveSubcategory} className="btn-primary py-2">Add Subcategory</button>
              </div>

              <div className="space-y-2">
                {getSubcategories(selectedCategory).map((subcategory) => (
                  <div key={`${selectedCategory}-${subcategory}`} className="flex items-center gap-2 border border-border rounded-sm px-3 py-2">
                    {editingSubcategory === subcategory ? (
                      <input className={`${input} flex-1`} value={editingSubcategoryValue} onChange={(event) => setEditingSubcategoryValue(event.target.value)} />
                    ) : (
                      <span className="flex-1 text-sm font-semibold">{subcategory}</span>
                    )}
                    {editingSubcategory === subcategory ? (
                      <button onClick={() => saveSubcategoryRename(subcategory)} className="btn-primary py-1.5 text-xs">Save</button>
                    ) : (
                      <button onClick={() => { setEditingSubcategory(subcategory); setEditingSubcategoryValue(subcategory); }} className="btn-secondary py-1.5 text-xs">Edit</button>
                    )}
                    <button onClick={() => deleteSubcategory(subcategory)} className="text-xs text-red-600 border border-red-200 rounded-sm px-3 py-1.5 hover:bg-red-50">Delete</button>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        )}

        {tab === 'custom-fields' && (
          <Panel title="Custom Fields" description="Create extra fields for internal tracking. They are saved locally and ready for use in stock/customer forms.">
            <div className="grid md:grid-cols-4 gap-2">
              <input className={input} value={fieldDraft.label} onChange={(event) => setFieldDraft((prev) => ({ ...prev, label: event.target.value }))} placeholder="Field label" />
              <select className={input} value={fieldDraft.type} onChange={(event) => setFieldDraft((prev) => ({ ...prev, type: event.target.value }))}>
                {textTypes.map((type) => <option key={type}>{type}</option>)}
              </select>
              <select className={input} value={fieldDraft.appliesTo} onChange={(event) => setFieldDraft((prev) => ({ ...prev, appliesTo: event.target.value }))}>
                {appliesTo.map((target) => <option key={target}>{target}</option>)}
              </select>
              <button onClick={addCustomField} className="btn-primary">Add Field</button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={fieldDraft.required} onChange={(event) => setFieldDraft((prev) => ({ ...prev, required: event.target.checked }))} />
              Required field
            </label>
            <Table rows={settings.customFields.map((field) => [field.label, field.type, field.appliesTo, field.required ? 'Required' : 'Optional'])} empty="No custom fields added." />
          </Panel>
        )}

        {tab === 'tag-templates' && (
          <Panel title="Tag Templates" description={`These values control /print-tags. Current active stock: ${activeSkuCount} SKUs.`}>
            <div className="grid md:grid-cols-3 gap-3">
              <NumberField label="Width (mm)" value={settings.tagTemplate.widthMm} onChange={(value) => persist({ ...settings, tagTemplate: { ...settings.tagTemplate, widthMm: value } })} />
              <NumberField label="Height (mm)" value={settings.tagTemplate.heightMm} onChange={(value) => persist({ ...settings, tagTemplate: { ...settings.tagTemplate, heightMm: value } })} />
              <NumberField label="Copies per SKU" value={settings.tagTemplate.copiesPerSku} onChange={(value) => persist({ ...settings, tagTemplate: { ...settings.tagTemplate, copiesPerSku: Math.max(1, value) } })} />
              <NumberField label="Font size" value={settings.tagTemplate.fontSize} onChange={(value) => persist({ ...settings, tagTemplate: { ...settings.tagTemplate, fontSize: value } })} />
              <NumberField label="Barcode height (mm)" value={settings.tagTemplate.barcodeHeightMm} onChange={(value) => persist({ ...settings, tagTemplate: { ...settings.tagTemplate, barcodeHeightMm: value } })} />
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
              state={settings.tagTemplate}
              onChange={(key, value) => persist({ ...settings, tagTemplate: { ...settings.tagTemplate, [key]: value } })}
            />
          </Panel>
        )}

        {tab === 'invoice-settings' && (
          <Panel title="Estimate Settings" description="Estimate defaults used by the sale page. GST stays zero because the customer document is an estimate only.">
            <div className="grid md:grid-cols-2 gap-3">
              <TextField label="Estimate prefix" value={settings.estimate.prefix} onChange={(value) => persist({ ...settings, estimate: { ...settings.estimate, prefix: value.toUpperCase() } })} />
              <NumberField label="Default gold rate per gram" value={settings.estimate.defaultGoldRate} onChange={(value) => persist({ ...settings, estimate: { ...settings.estimate, defaultGoldRate: value } })} />
              <NumberField label="Default silver rate per gram" value={settings.estimate.defaultSilverRate} onChange={(value) => persist({ ...settings, estimate: { ...settings.estimate, defaultSilverRate: value } })} />
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={settings.estimate.roundOff} onChange={(event) => persist({ ...settings, estimate: { ...settings.estimate, roundOff: event.target.checked } })} />
                Round off final estimate total
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-semibold text-muted-foreground">Footer note</span>
              <textarea className={`${input} mt-1 min-h-24`} value={settings.estimate.footerNote} onChange={(event) => persist({ ...settings, estimate: { ...settings.estimate, footerNote: event.target.value } })} />
            </label>
          </Panel>
        )}

        {tab === 'taxes' && (
          <Panel title="Taxes" description="Estimates are kept GST-free. You can store business GST details, but estimate tax remains zero.">
            <div className="grid md:grid-cols-3 gap-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={settings.taxes.gstEnabled} onChange={(event) => persist({ ...settings, taxes: { ...settings.taxes, gstEnabled: event.target.checked, estimateTaxPercent: 0 } })} />
                GST registered business
              </label>
              <NumberField label="Business GST percent" value={settings.taxes.gstPercent} onChange={(value) => persist({ ...settings, taxes: { ...settings.taxes, gstPercent: value, estimateTaxPercent: 0 } })} />
              <TextField label="Estimate GST" value="0%" onChange={() => undefined} disabled />
            </div>
          </Panel>
        )}

        {tab === 'users' && (
          <Panel title="Users & Permissions" description="Control local staff permissions, including original net weight visibility and stock editing.">
            <div className="grid md:grid-cols-3 gap-2">
              <input className={input} value={userDraft.name} onChange={(event) => setUserDraft((prev) => ({ ...prev, name: event.target.value }))} placeholder="Staff name" />
              <select className={input} value={userDraft.role} onChange={(event) => setUserDraft((prev) => ({ ...prev, role: event.target.value }))}>
                {roles.map((role) => <option key={role}>{role}</option>)}
              </select>
              <button onClick={addUser} className="btn-primary">Add User</button>
            </div>
            <div className="space-y-2">
              {settings.users.map((user) => (
                <div key={user.id} className="grid md:grid-cols-[1fr_150px_160px_130px] gap-2 items-center border border-border rounded-sm p-3">
                  <strong className="text-sm">{user.name}</strong>
                  <span className="text-xs text-muted-foreground">{user.role}</span>
                  <label className="text-xs flex items-center gap-2"><input type="checkbox" checked={user.canSeeOriginalWeight} onChange={(event) => persist({ ...settings, users: settings.users.map((item) => item.id === user.id ? { ...item, canSeeOriginalWeight: event.target.checked } : item) })} /> Original weight</label>
                  <label className="text-xs flex items-center gap-2"><input type="checkbox" checked={user.canEditStock} onChange={(event) => persist({ ...settings, users: settings.users.map((item) => item.id === user.id ? { ...item, canEditStock: event.target.checked } : item) })} /> Edit stock</label>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {tab === 'numbering' && (
          <Panel title="Numbering" description="Set padding, barcode prefix, and category prefixes used for newly created designs and SKUs.">
            <div className="grid md:grid-cols-3 gap-3">
              <NumberField label="Design number padding" value={settings.numbering.designPadding} onChange={(value) => persist({ ...settings, numbering: { ...settings.numbering, designPadding: value } })} />
              <NumberField label="SKU serial padding" value={settings.numbering.skuPadding} onChange={(value) => persist({ ...settings, numbering: { ...settings.numbering, skuPadding: value } })} />
              <TextField label="Barcode prefix" value={settings.numbering.barcodePrefix} onChange={(value) => persist({ ...settings, numbering: { ...settings.numbering, barcodePrefix: value.toUpperCase() } })} />
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
              {categories.map((category) => (
                <label key={`num-${category}`} className="flex items-center justify-between gap-3 border border-border rounded-sm px-3 py-2">
                  <span className="text-sm font-semibold">{category}</span>
                  <input className={`${input} w-24 uppercase`} value={settings.numbering.categoryPrefixes[category] || ''} onChange={(event) => updatePrefix(category, event.target.value)} />
                </label>
              ))}
            </div>
          </Panel>
        )}

        {tab === 'business' && (
          <Panel title="Business Settings" description="Saved local business details for print layouts and operational records.">
            <div className="grid md:grid-cols-2 gap-3">
              <TextField label="Legal name" value={settings.business.legalName} onChange={(value) => persist({ ...settings, business: { ...settings.business, legalName: value } })} />
              <TextField label="Display name" value={settings.business.displayName} onChange={(value) => persist({ ...settings, business: { ...settings.business, displayName: value } })} />
              <TextField label="Showroom / branch" value={settings.business.location} onChange={(value) => persist({ ...settings, business: { ...settings.business, location: value } })} />
              <TextField label="Owner / admin name" value={settings.business.ownerName} onChange={(value) => persist({ ...settings, business: { ...settings.business, ownerName: value } })} />
              <TextField label="Phone" value={settings.business.phone} onChange={(value) => persist({ ...settings, business: { ...settings.business, phone: value } })} />
              <TextField label="GSTIN" value={settings.business.gstin} onChange={(value) => persist({ ...settings, business: { ...settings.business, gstin: value.toUpperCase() } })} />
            </div>
            <TextField label="Tagline" value={settings.business.tagline} onChange={(value) => persist({ ...settings, business: { ...settings.business, tagline: value } })} />
            <label className="block">
              <span className="text-xs font-semibold text-muted-foreground">Address</span>
              <textarea className={`${input} mt-1 min-h-24`} value={settings.business.address} onChange={(event) => persist({ ...settings, business: { ...settings.business, address: event.target.value } })} />
            </label>
          </Panel>
        )}
      </section>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
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

function TextField({ label, value, onChange, disabled = false }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <input className="input-field text-sm mt-1" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <input className="input-field text-sm mt-1" type="number" value={value} min={0} onChange={(event) => onChange(parseFloat(event.target.value) || 0)} />
    </label>
  );
}

function CheckList<T extends Record<string, unknown>>({
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
          <input type="checkbox" checked={Boolean(state[key])} onChange={(event) => onChange(key, event.target.checked)} />
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
        <div key={`${row.join('-')}-${index}`} className="grid grid-cols-4 gap-2 px-3 py-2 text-sm border-b last:border-b-0 border-border">
          {row.map((cell) => <span key={`${index}-${cell}`}>{cell}</span>)}
        </div>
      ))}
    </div>
  );
}
