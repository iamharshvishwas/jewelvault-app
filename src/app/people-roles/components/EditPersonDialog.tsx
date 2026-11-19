'use client';
import React, { useState } from 'react';
import type { SuperPerson } from '@/lib/api/types';
import {
  NOTHING_CHANGED_YET,
  editChanges,
  validateEditPerson,
  type EditValues,
} from '../lib/people';
import { editPersonChange, type PersonChange } from '../lib/personChange';
import ChangeSteps from './ChangeSteps';
import FormDialog from './FormDialog';
import { TextField } from './FormFields';

// "Edit" (plan: access and roles, Task 23): the name and the e-mail of a person, then the password step. Only what changed is sent, and a form where nothing changed does not go on.
// It is also the one button of the Super Admin's own row (R12: she may change her name and e-mail, nothing else of that login).

export default function EditPersonDialog({
  person,
  meId,
  reload,
  onClose,
}: {
  person: SuperPerson;
  /** The id of the person who is signed in: an e-mail changed on her own row ends only her other sessions (R11). */
  meId: string;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<EditValues>({
    full_name: person.full_name,
    email: person.email,
  });
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

  const set = (field: keyof EditValues) => (value: string) => {
    setValues((now) => ({ ...now, [field]: value }));
    setErrors({});
  };
  const submit = () => {
    const found = validateEditPerson(values);
    if (Object.keys(found).length === 0 && Object.keys(editChanges(person, values)).length === 0)
      found.form = NOTHING_CHANGED_YET;
    setErrors(found);
    if (Object.keys(found).length === 0) setChange(editPersonChange(person, values, meId));
  };

  return (
    <FormDialog
      testId="edit-person"
      title={`Edit ${person.full_name}`}
      formError={errors.form ?? null}
      onSubmit={submit}
      onClose={onClose}
    >
      <TextField
        label="Name"
        testId="edit-person-name"
        value={values.full_name}
        onChange={set('full_name')}
        error={errors.full_name}
        maxLength={120}
      />
      <TextField
        label="E-mail"
        testId="edit-person-email"
        type="email"
        value={values.email}
        onChange={set('email')}
        error={errors.email}
        maxLength={254}
      />
    </FormDialog>
  );
}
