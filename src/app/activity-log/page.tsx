import React from 'react';
import AppLayout from '@/components/AppLayout';
import ActivityLogClient from './components/ActivityLogClient';

export default function ActivityLogPage() {
  return (
    <AppLayout>
      <ActivityLogClient />
    </AppLayout>
  );
}
