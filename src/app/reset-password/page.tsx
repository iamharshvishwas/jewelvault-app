import React from 'react';
import AppLayout from '@/components/AppLayout';
import ResetPasswordScreen from '@/components/ResetPasswordScreen';

// Opens whatever the session state: AppLayout shows this page before its sign-in check (standalonePathScreen).
export default function ResetPasswordPage() {
  return (
    <AppLayout>
      <ResetPasswordScreen />
    </AppLayout>
  );
}
