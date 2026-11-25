'use client';
import React, { useMemo, useState } from 'react';
import type { SuperPerson, SuperRole } from '@/lib/api/types';
import { activeRoleChoices, validateRoleChoice } from '../lib/people';
import { rolePersonChange, type PersonChange } from '../lib/personChange';
import ChangeSteps from './ChangeSteps';
import FormDialog from './FormDialog';
import { RoleSelect } from './FormFields';

// "Change role" (plan: access and roles, Task 23): the role of a person, chosen from the active roles (the Owner too) by name, then the password step. The person's present role is chosen
// when it is one of the choices; a person whose role is switched off has none chosen (and may be given another one, which is what makes them able to be switched on again).

export default function ChangeRoleDialog({
  person,
  roles,
  reload,
  onClose,
}: {
  person: SuperPerson;
  roles: SuperRole[];
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const choices = useMemo(() => activeRoleChoices(roles), [roles]);
  const [role, setRole] = useState(() =>
    choices.some((r) => r.key === person.role) ? person.role : ''
  );
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

  const submit = () => {
    const chosen = choices.some((r) => r.key === role) ? role : ''; // a role switched off since is no choice
    const found = validateRoleChoice(person, chosen);
    setErrors(found);
    if (Object.keys(found).length === 0) setChange(rolePersonChange(person, chosen, choices));
  };

  return (
    <FormDialog
      testId="change-role"
      title={`Change role of ${person.full_name}`}
      intro={<p className="text-muted-foreground">{`Current role: ${person.role_name}.`}</p>}
      onSubmit={submit}
      onClose={onClose}
    >
      <RoleSelect
        label="New role"
        testId="change-role-role"
        choices={choices}
        value={role}
        onChange={(key) => {
          setRole(key);
          setErrors({});
        }}
        error={errors.role}
        required
      />
    </FormDialog>
  );
}
