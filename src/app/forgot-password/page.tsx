import React from 'react';
import AppLayout from '@/components/AppLayout';
import ForgotPasswordScreen from '@/components/ForgotPasswordScreen';

// Opens whatever the session state: AppLayout shows this page before its sign-in check (standalonePathScreen).
export default function ForgotPasswordPage() {
  return (
    <AppLayout>
      <ForgotPasswordScreen />
    </AppLayout>
  );
}
