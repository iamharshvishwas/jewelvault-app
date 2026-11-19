'use client';
import React from 'react';
import type { SuperRole } from '@/lib/api/types';
import { switchRoleChange } from '../lib/roleChange';
import RoleSteps from './RoleSteps';

// "Switch off" and "Switch on" of a role (plan: access and roles, Task 24): no form, so the button goes straight to the password step. The role is switched the other way from the way it is.
// The write names the `updated_at` the row was listed with: if the role was changed in another tab since, the step says so and the lists are read again (`runRoleChange`).
export default function SwitchRoleDialog({
  role,
  reload,
  onClose,
}: {
  role: SuperRole;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <RoleSteps change={switchRoleChange(role)} reload={reload} onBack={onClose} onClose={onClose} />
  );
}
