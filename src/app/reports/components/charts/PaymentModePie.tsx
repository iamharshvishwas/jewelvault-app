'use client';
import React from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface DataPoint {
  mode: string;
  value: number;
  amount: number;
  fill: string;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { name: string; payload: { amount: number; value: number } }[] }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0];
  return (
    <div className="jewel-card-elevated px-3 py-2 text-xs">
      <p className="font-semibold text-foreground">{p?.name}</p>
      <p className="text-muted-foreground">{p?.payload.value}% of transactions</p>
      <p className="text-primary font-semibold font-tabular">₹{p?.payload.amount.toLocaleString('en-IN')}</p>
    </div>
  );
}

export default function PaymentModePie({ data }: { data: DataPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="45%"
          innerRadius={60}
          outerRadius={85}
          paddingAngle={2}
          dataKey="value"
          nameKey="mode"
        >
          {data.map((entry, index) => (
            <Cell key={`pmcell-${index}`} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
        <Legend
          iconType="circle"
          iconSize={8}
          formatter={(value: string) => (
            <span style={{ fontSize: '11px', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)' }}>
              {value}
            </span>
          )}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}