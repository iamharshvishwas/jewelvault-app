'use client';
import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface DataPoint {
  bucket: string;
  count: number;
  weight: number;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; name: string }[]; label?: string }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="jewel-card-elevated px-3 py-2 text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={`ageing-tt-${i}`} className="text-muted-foreground">{p.name}: <span className="font-semibold text-foreground">{p.value}</span></p>
      ))}
    </div>
  );
}

const BUCKET_COLORS = ['#16a34a', '#D4AF37', '#d97706', '#dc2626', '#9f1239'];

export default function AgeingBarChart({ data }: { data: DataPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barSize={32} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.5 }} />
        <Bar dataKey="count" name="SKUs" radius={[4, 4, 0, 0]}>
          {data.map((entry, index) => (
            <Cell key={`ageing-cell-${index}`} fill={BUCKET_COLORS[index] ?? 'var(--primary)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}