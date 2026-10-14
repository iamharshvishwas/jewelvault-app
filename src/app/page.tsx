'use client';
import React, { useEffect, useState } from 'react';
import AppLayout from '@/components/AppLayout';
import DashboardKpiGrid from './components/DashboardKpiGrid';
import DashboardCharts from './components/DashboardCharts';
import RecentDesignsGrid from './components/RecentDesignsGrid';
import DashboardActivityPanels from './components/DashboardActivityPanels';
import DashboardQuickActions from './components/DashboardQuickActions';
import DashboardRateCard from './components/DashboardRateCard';
import { BUSINESS_LOCATION, BUSINESS_NAME } from '@/lib/businessConfig';
import { getSession, type AuthSession } from '@/lib/authStore';

export default function HomePage() {
  const [dateLabel, setDateLabel] = useState('');
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    const d = new Date();
    setDateLabel(
      d?.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    );
    setSession(getSession());
  }, []);

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{BUSINESS_NAME}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {dateLabel ? `${dateLabel} - ${BUSINESS_LOCATION}` : BUSINESS_LOCATION}
            </p>
          </div>
        </div>

        {/* Quick Actions */}
        <DashboardQuickActions role={session?.role ?? 'Admin'} />

        {/* Daily Rates */}
        {session?.role === 'Admin' && <DashboardRateCard />}

        {/* KPI Grid */}
        <DashboardKpiGrid role={session?.role ?? 'Admin'} />

        {/* Charts */}
        {session?.role === 'Admin' && <DashboardCharts />}

        {/* Recent Designs */}
        <RecentDesignsGrid />

        {/* Activity Panels */}
        {session?.role === 'Admin' && <DashboardActivityPanels />}
      </div>
    </AppLayout>
  );
}
