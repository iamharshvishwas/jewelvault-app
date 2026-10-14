'use client';
import React from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
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
        <p key={`gsarea-tt-${i}`} style={{ color: p.color }}>
          {p.name}: ₹{(p.value / 1000).toFixed(1)}K
        </p>
      ))}
    </div>
  );
}

export default function GoldSilverAreaChart({ data }: { data: DataPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <defs>
          <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
            <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="silverGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#9e9e9e" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#9e9e9e" stopOpacity={0.02} />
          </linearGradient>
        </defs>
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
        <Tooltip content={<CustomTooltip />} />
        <Legend
          formatter={(value: string) => (
            <span style={{ fontSize: '11px', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}>{value}</span>
          )}
        />
        <Area
          type="monotone"
          dataKey="goldSales"
          name="Gold"
          stroke="var(--accent)"
          strokeWidth={2}
          fill="url(#goldGrad)"
        />
        <Area
          type="monotone"
          dataKey="silverSales"
          name="Silver"
          stroke="#9e9e9e"
          strokeWidth={2}
          fill="url(#silverGrad)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}