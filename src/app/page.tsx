'use client';
import React, { useSyncExternalStore } from 'react';
import AppLayout from '@/components/AppLayout';
import DashboardKpiGrid from './components/DashboardKpiGrid';
import DashboardCharts from './components/DashboardCharts';
import RecentDesignsGrid from './components/RecentDesignsGrid';
import DashboardActivityPanels from './components/DashboardActivityPanels';
import DashboardQuickActions from './components/DashboardQuickActions';
import DashboardRateCard from './components/DashboardRateCard';
import DashboardHealthLine from './components/DashboardHealthLine';
import DashboardDownloadCard from './components/DashboardDownloadCard';
import DashboardEveningCheck from './components/DashboardEveningCheck';
import { BUSINESS_LOCATION, BUSINESS_NAME } from '@/lib/businessConfig';
import { useSession } from '@/lib/authStore';

const noSubscription = () => () => {};

function todayLabel() {
  return new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export default function HomePage() {
  // The date is empty in the static HTML (it would be the day of the build) and today's on the screen.
  const dateLabel = useSyncExternalStore(noSubscription, todayLabel, () => '');
  // U7: the role comes from the one session of the application, never from a read of the page's own. Until it is known
  // (and AppLayout shows nothing of the page until then) the page asks for the least.
  const { role: signedInRole } = useSession();
  const role = signedInRole ?? 'staff';

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

        {/* The owner's health line: the nightly check, the backups, the Download everything reminder (spec section 12) */}
        {role === 'owner' && <DashboardHealthLine />}

        {/* The owner's monthly Download everything: the date of the last one, the reminder, the button (spec B3, O53) */}
        {role === 'owner' && <DashboardDownloadCard />}

        {/* Quick Actions */}
        <DashboardQuickActions role={role} />

        {/* Daily Rates */}
        {role === 'owner' && <DashboardRateCard />}

        {/* KPI Grid */}
        <DashboardKpiGrid role={role} />

        {/* The owner's evening check: today's Cash net, today's UPI net, the total outstanding (V4, V2) */}
        {role === 'owner' && <DashboardEveningCheck />}

        {/* Charts */}
        {role === 'owner' && <DashboardCharts />}

        {/* Recent Designs */}
        <RecentDesignsGrid />

        {/* Activity Panels */}
        {role === 'owner' && <DashboardActivityPanels />}
      </div>
    </AppLayout>
  );
}
