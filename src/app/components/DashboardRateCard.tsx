'use client';

import React, { useEffect, useState } from 'react';
import { Save, TrendingUp } from 'lucide-react';
import { getSettings, saveSettings } from '@/lib/settingsStore';

function todayLabel() {
  return new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function DashboardRateCard() {
  const [goldRate, setGoldRate] = useState(0);
  const [silverRate, setSilverRate] = useState(0);
  const [saved, setSaved] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');

  useEffect(() => {
    const settings = getSettings();
    setGoldRate(settings.estimate.defaultGoldRate);
    setSilverRate(settings.estimate.defaultSilverRate);
    setUpdatedAt(todayLabel());
  }, []);

  const handleSave = () => {
    const settings = getSettings();
    saveSettings({
      ...settings,
      estimate: {
        ...settings.estimate,
        defaultGoldRate: Math.max(0, goldRate),
        defaultSilverRate: Math.max(0, silverRate),
      },
    });
    setSaved(true);
    setUpdatedAt(todayLabel());
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <section className="jewel-card p-4">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-sm bg-gold-subtle text-primary flex items-center justify-center">
              <TrendingUp size={17} />
            </span>
            <div>
              <h2 className="text-sm font-bold text-foreground">Daily Metal Rates</h2>
              <p className="text-xs text-muted-foreground">Used automatically while making estimates</p>
            </div>
          </div>
        </div>

        <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 w-full lg:w-auto lg:min-w-[620px]">
          <label className="text-xs font-semibold text-muted-foreground">
            Gold Rate (per gram)
            <div className="relative mt-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
              <input
                type="number"
                value={goldRate || ''}
                onChange={(event) => setGoldRate(parseFloat(event.target.value) || 0)}
                className="input-field pl-7 py-2 font-tabular"
                min={0}
                step="0.01"
              />
            </div>
          </label>

          <label className="text-xs font-semibold text-muted-foreground">
            Silver Rate (per gram)
            <div className="relative mt-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
              <input
                type="number"
                value={silverRate || ''}
                onChange={(event) => setSilverRate(parseFloat(event.target.value) || 0)}
                className="input-field pl-7 py-2 font-tabular"
                min={0}
                step="0.01"
              />
            </div>
          </label>

          <button onClick={handleSave} className="btn-primary py-2 self-end justify-center">
            <Save size={15} />
            Save Rates
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        <p className="text-muted-foreground">Last updated: {updatedAt || '-'}</p>
        {saved && <p className="font-semibold text-emerald-600">Rates saved</p>}
      </div>
    </section>
  );
}
