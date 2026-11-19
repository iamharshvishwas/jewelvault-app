'use client';
import React from 'react';
import type { SuperPerson } from '@/lib/api/types';
import { resetPersonChange } from '../lib/personChange';
import ChangeSteps from './ChangeSteps';

// "Reset password" (plan: access and roles, Task 23): no form, so the button goes straight to the password step, and after it the new temporary password is shown once.
export default function ResetPasswordDialog({
  person,
  reload,
  onClose,
}: {
  person: SuperPerson;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <ChangeSteps
      change={resetPersonChange(person)}
      reload={reload}
      onBack={onClose}
      onClose={onClose}
    />
  );
}
