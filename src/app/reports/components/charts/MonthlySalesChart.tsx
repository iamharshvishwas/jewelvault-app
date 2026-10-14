'use client';
import React from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend
} from 'recharts';

interface DataPoint {
  month: string;
  goldSales: number;
  silverSales: number;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="jewel-card-elevated px-3 py-2 text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={`monthly-tt-${i}`} style={{ color: p.color }}>
          {p.name}: ₹{(p.value / 1000).toFixed(0)}K
        </p>
      ))}
    </div>
  );
}

export default function MonthlySalesChart({ data }: { data: DataPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} barSize={20} barGap={4} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.4 }} />
        <Legend
          formatter={(value: string) => (
            <span style={{ fontSize: '11px', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}>{value}</span>
          )}
        />
        <Bar dataKey="goldSales" name="Gold" fill="var(--accent)" radius={[3, 3, 0, 0]} />
        <Bar dataKey="silverSales" name="Silver" fill="var(--silver-mid)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}