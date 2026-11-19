'use client';
import React, { useMemo, useState } from 'react';
import type { SuperRole } from '@/lib/api/types';
import { activeRoleChoices, validateNewPerson, type NewPersonValues } from '../lib/people';
import { newPersonChange, type PersonChange } from '../lib/personChange';
import ChangeSteps from './ChangeSteps';
import FormDialog from './FormDialog';
import { RoleSelect, TextField } from './FormFields';

// "+ Add person" (plan: access and roles, Task 23): a form with the name, the e-mail and the role; then the password step; then the temporary password, shown once.
//   - the roles to choose from are the active ones, the Owner too (`activeRoleChoices`), by their names;
//   - the form checks what the API checks, so a mistake is shown here and not after the password was typed (`validateNewPerson`);
//   - "Cancel" on the password step brings the form back with everything typed, so that a refusal of the API (a taken e-mail) is mended on the form and not typed again.

const EMPTY: NewPersonValues = { full_name: '', email: '', role: '' };

export default function AddPersonDialog({
  roles,
  reload,
  onClose,
}: {
  roles: SuperRole[];
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const choices = useMemo(() => activeRoleChoices(roles), [roles]);
  const [values, setValues] = useState<NewPersonValues>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [change, setChange] = useState<PersonChange | null>(null);

  if (change !== null)
    return (
      <ChangeSteps
        change={change}
        reload={reload}
        onBack={() => setChange(null)}
        onClose={onClose}
      />
    );

  const set = (field: keyof NewPersonValues) => (value: string) => {
    setValues((now) => ({ ...now, [field]: value }));
    setErrors((now) => ({ ...now, [field]: '' }));
  };
  const submit = () => {
    // a role that was switched off since it was chosen is no choice any more
    const role = choices.some((r) => r.key === values.role) ? values.role : '';
    const found = validateNewPerson({ ...values, role });
    setErrors(found);
    if (Object.keys(found).length === 0) setChange(newPersonChange({ ...values, role }, choices));
  };

  return (
    <FormDialog testId="add-person" title="Add person" onSubmit={submit} onClose={onClose}>
      <TextField
        label="Name"
        testId="add-person-name"
        value={values.full_name}
        onChange={set('full_name')}
        error={errors.full_name}
        maxLength={120}
      />
      <TextField
        label="E-mail"
        testId="add-person-email"
        type="email"
        value={values.email}
        onChange={set('email')}
        error={errors.email}
        maxLength={254}
      />
      <RoleSelect
        label="Role"
        testId="add-person-role"
        choices={choices}
        value={values.role}
        onChange={set('role')}
        error={errors.role}
      />
    </FormDialog>
  );
}
