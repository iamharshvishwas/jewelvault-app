'use client';
import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

interface DataPoint {
  day: string;
  sales: number;
  invoices: number;
  /** The bar of today is drawn in the main colour. */
  today?: boolean;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="jewel-card-elevated px-3 py-2 text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      <p className="text-primary font-tabular">
        ₹{Number(payload[0]?.value).toLocaleString('en-IN')}
      </p>
    </div>
  );
}

export default function DailySalesChart({ data }: { data: DataPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barSize={28} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="day"
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v))}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.5 }} />
        <Bar dataKey="sales" radius={[4, 4, 0, 0]}>
          {data.map((entry, index) => (
            <Cell
              key={`cell-daily-${index}`}
              fill={
                entry.sales === 0
                  ? 'var(--muted)'
                  : entry.today
                    ? 'var(--primary)'
                    : 'var(--accent)'
              }
              opacity={entry.sales === 0 ? 0.4 : 1}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
