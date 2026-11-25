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
import DashboardOverduePanel from './components/DashboardOverduePanel';
import DashboardOrdersPanel from './components/DashboardOrdersPanel';
import { BUSINESS_LOCATION, BUSINESS_NAME } from '@/lib/businessConfig';
import { dashboardAccess } from '@/lib/dashboardAccess';
import { useHolder } from '@/lib/useAccess';

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
  // U7: what the person may do comes from the one session of the application, never from a read of the page's own. Until it is known
  // (and AppLayout shows nothing of the page until then) nobody holds a tick, so the page asks for the least. Each block is shown for the ticks of the data it
  // reads and of the action it offers (src/lib/dashboardAccess.ts); the quick actions and the KPI grid decide their own items from the holder.
  const holder = useHolder();
  const show = dashboardAccess(holder);

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

        {/* The health line: the nightly check, the backups, the Download everything reminder (spec section 12) */}
        {show.healthLine && <DashboardHealthLine />}

        {/* The monthly Download everything: the date of the last one, the reminder, the button (spec B3, O53) */}
        {show.downloadCard && <DashboardDownloadCard />}

        {/* Quick Actions */}
        <DashboardQuickActions holder={holder} />

        {/* Daily Rates */}
        {show.rateCard && <DashboardRateCard />}

        {/* KPI Grid */}
        <DashboardKpiGrid holder={holder} />

        {/* FB-F1: the orders due in the next 2 days or overdue, for whoever reads the orders (without the customer for whoever may not see customers) */}
        {show.ordersPanel && <DashboardOrdersPanel />}

        {/* FB-D3: the customers with a payment pending for more than 60 days (V1), for whoever reads the bills and the customers: the owner and the biller */}
        {show.overduePanel && <DashboardOverduePanel />}

        {/* The evening check: today's Cash net, today's UPI net, the total outstanding (V4, V2) */}
        {show.eveningCheck && <DashboardEveningCheck />}

        {/* Charts */}
        {show.charts && <DashboardCharts />}

        {/* Recent Designs */}
        <RecentDesignsGrid />

        {/* Activity Panels */}
        {show.activityPanels && <DashboardActivityPanels />}
      </div>
    </AppLayout>
  );
}
