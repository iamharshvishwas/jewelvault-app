'use client';
import React, { useMemo, useState } from 'react';
import type { SuperRole } from '@/lib/api/types';
import { newRoleChange, type RoleChange } from '../lib/roleChange';
import { startFromChoices, validateNewRole, type NewRoleValues } from '../lib/roles';
import FormDialog from './FormDialog';
import { RoleSelect, TextAreaField, TextField } from './FormFields';
import RoleSteps from './RoleSteps';

// "+ New role" and "Copy" (plan: access and roles, Task 24): a form with the role to start from, the name and what the role is for; then the password step. Copy is the same form with the role
// of the row chosen to start from; the name is left empty (nothing is suggested). The new role gets the same ticks as the one it starts from; changing them is the Edit button, afterwards.
//   - the roles to start from are all of them, the Owner and the switched-off ones too, by their names (`startFromChoices`), as the API takes a copy of any role;
//   - the form checks what the API checks, so a mistake is shown here and not after the password was typed (`validateNewRole`);
//   - "Cancel" on the password step brings the form back with everything typed, so that a refusal of the API (a name that another role has) is mended on the form and not typed again.

export default function NewRoleDialog({
  roles,
  copyOf,
  reload,
  onClose,
}: {
  roles: SuperRole[];
  /** The key of the role to start from when the dialog opens (Copy), or an empty text (+ New role). */
  copyOf: string;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const choices = useMemo(() => startFromChoices(roles), [roles]);
  const [values, setValues] = useState<NewRoleValues>(() => ({
    copy_of: choices.some((r) => r.key === copyOf) ? copyOf : '',
    name: '',
    description: '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [change, setChange] = useState<RoleChange | null>(null);

  if (change !== null)
    return (
      <RoleSteps change={change} reload={reload} onBack={() => setChange(null)} onClose={onClose} />
    );

  const set = (field: keyof NewRoleValues) => (value: string) => {
    setValues((now) => ({ ...now, [field]: value }));
    setErrors((now) => ({ ...now, [field]: '' }));
  };
  const submit = () => {
    // a role that is not listed any more is no choice
    const from = choices.some((r) => r.key === values.copy_of) ? values.copy_of : '';
    const found = validateNewRole({ ...values, copy_of: from });
    setErrors(found);
    if (Object.keys(found).length === 0)
      setChange(newRoleChange({ ...values, copy_of: from }, roles));
  };

  return (
    <FormDialog
      testId="new-role"
      title="New role"
      intro={
        <p className="text-muted-foreground">
          The new role starts with the same ticks as the role you start from.
        </p>
      }
      onSubmit={submit}
      onClose={onClose}
    >
      <RoleSelect
        label="Start from"
        testId="new-role-from"
        choices={choices}
        value={values.copy_of}
        onChange={set('copy_of')}
        error={errors.copy_of}
      />
      <TextField
        label="Name"
        testId="new-role-name"
        capitalize="words"
        value={values.name}
        onChange={set('name')}
        error={errors.name}
        maxLength={40}
      />
      <TextAreaField
        label="Description (optional)"
        testId="new-role-description"
        value={values.description}
        onChange={set('description')}
        error={errors.description}
        maxLength={200}
      />
    </FormDialog>
  );
}
