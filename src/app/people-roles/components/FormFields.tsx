'use client';
import React, { useId } from 'react';
import type { SuperRole } from '@/lib/api/types';

// The fields of the forms before the password step (plan: access and roles, Task 23): a label, the control, and the sentence that says what is wrong with it. The look is the one of the
// password field of ConfirmPasswordDialog.
//   - what a phone does with capital letters is chosen for each field (`capitalize`): a name starts with a capital letter ("words"), an e-mail or a code never does ("none"). The prop has
//     no default, so that a new field has to say which it is;
//   - whether a field must be filled is said for each field too (`required`, no default): it is drawn as `aria-required`, which is also what tells the frame of a form (`firstToFill`) where
//     the cursor goes. The forms are not checked by the browser (they are `noValidate`): the sentences of the screen say what is missing;
//   - a text field is drawn in a dialog by default; on a page of its own (the Edit role screen) `look="page"` gives it the small capital label of the picture (mockups/3-edit-role.png).

const LABEL = 'text-xs font-semibold text-foreground block';
const PAGE_LABEL = 'block';
const PAGE_LABEL_TEXT = 'block text-xs font-bold uppercase tracking-wider text-muted-foreground';

/** Where a field is drawn: in a dialog (the default), or on a page of its own. */
export type FieldLook = 'dialog' | 'page';

function Label({ look, text }: { look: FieldLook; text: string }) {
  return look === 'page' ? <span className={PAGE_LABEL_TEXT}>{text}</span> : <>{text}</>;
}

function FieldError({ id, error }: { id: string; error: string | undefined }) {
  if (!error) return null;
  return (
    <p id={id} className="mt-1.5 text-xs font-semibold text-red-700">
      {error}
    </p>
  );
}

export function TextField({
  label,
  value,
  onChange,
  error,
  testId,
  type = 'text',
  maxLength,
  capitalize,
  required,
  look = 'dialog',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  testId: string;
  type?: 'text' | 'email';
  maxLength?: number;
  /** What a phone's keyboard does with capital letters: "words" for a name, "none" for an e-mail or a code. */
  capitalize: 'words' | 'none';
  /** Whether the field must be filled in. */
  required: boolean;
  look?: FieldLook;
}) {
  const errorId = useId();
  return (
    <div>
      <label className={look === 'page' ? PAGE_LABEL : LABEL}>
        <Label look={look} text={label} />
        <input
          type={type}
          data-testid={testId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={maxLength}
          autoComplete="off"
          autoCapitalize={capitalize}
          spellCheck={false}
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="input-field text-sm mt-1.5 font-normal"
        />
      </label>
      <FieldError id={errorId} error={error} />
    </div>
  );
}

/** A text of several lines (the description of a role): a plain text box, with the same look and the same sentence for what is wrong. */
export function TextAreaField({
  label,
  value,
  onChange,
  error,
  testId,
  maxLength,
  required,
  look = 'dialog',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  testId: string;
  maxLength?: number;
  /** Whether the field must be filled in. */
  required: boolean;
  look?: FieldLook;
}) {
  const errorId = useId();
  return (
    <div>
      <label className={look === 'page' ? PAGE_LABEL : LABEL}>
        <Label look={look} text={label} />
        <textarea
          data-testid={testId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={maxLength}
          rows={3}
          autoComplete="off"
          autoCapitalize="sentences"
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="input-field text-sm mt-1.5 font-normal min-h-20"
        />
      </label>
      <FieldError id={errorId} error={error} />
    </div>
  );
}

/**
 * A choice of roles by their NAMES. The options are numbered by their place in the list, so that no role key is ever in the page: the key is what the screen keeps, the name is what the
 * person sees. A key that is not among the choices (a role switched off since) shows as nothing chosen.
 */
export function RoleSelect({
  label,
  choices,
  value,
  onChange,
  error,
  testId,
  required,
}: {
  label: string;
  choices: readonly SuperRole[];
  /** The key of the role chosen, or an empty text. */
  value: string;
  onChange: (key: string) => void;
  error?: string;
  testId: string;
  /** Whether a role must be chosen. */
  required: boolean;
}) {
  const errorId = useId();
  const chosen = choices.findIndex((r) => r.key === value);
  return (
    <div>
      <label className={LABEL}>
        {label}
        <select
          data-testid={testId}
          value={chosen === -1 ? '' : String(chosen)}
          onChange={(event) => {
            const place = Number(event.target.value);
            onChange(event.target.value === '' ? '' : (choices[place]?.key ?? ''));
          }}
          aria-required={required ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="input-field text-sm mt-1.5 font-normal"
        >
          <option value="">Choose a role</option>
          {choices.map((r, place) => (
            <option key={r.key} value={String(place)}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <FieldError id={errorId} error={error} />
    </div>
  );
}
