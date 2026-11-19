'use client';
import React from 'react';
import type { SuperPerson } from '@/lib/api/types';
import { switchPersonChange } from '../lib/personChange';
import ChangeSteps from './ChangeSteps';

// "Switch off" and "Switch on" (plan: access and roles, Task 23): no form, so the button goes straight to the password step. The person is switched the other way from the way they are.
export default function SwitchPersonDialog({
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
      change={switchPersonChange(person)}
      reload={reload}
      onBack={onClose}
      onClose={onClose}
    />
  );
}
