'use client';

import React, { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// A password input with an eye button at its right end (Completion-Plan/password-help-2026-11-26/DESIGN.md, part 1). It starts hidden;
// the button shows what was typed and hides it again. The button sits outside the <label>, which names the input by id, so the field's
// name is exactly its label. The button's own name never says "password": the browser tests find the field with getByLabel('Password'),
// which matches every element whose name contains that word.

/** The spoken name of the eye button: what a click will do. */
export const revealLabel = (shown: boolean) =>
  shown ? 'Hide what you typed' : 'Show what you typed';

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'id' | 'className'>;

export interface PasswordFieldProps extends InputProps {
  label: React.ReactNode;
  /** the classes of the label (the text above the field) */
  labelClassName: string;
  /** the classes of the input, without margins: the space above the field goes in `fieldClassName` */
  inputClassName: string;
  /** the classes of the box that holds the input and the button (for example its top margin) */
  fieldClassName?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  /** an extra line under the field, inside the same block */
  children?: React.ReactNode;
}

export default function PasswordField({
  label,
  labelClassName,
  inputClassName,
  fieldClassName = 'mt-1',
  inputRef,
  children,
  ...input
}: PasswordFieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label htmlFor={id} className={labelClassName}>
        {label}
      </label>
      <div className={`relative ${fieldClassName}`}>
        <input
          {...input}
          ref={inputRef}
          id={id}
          type={shown ? 'text' : 'password'}
          className={`${inputClassName} pr-10`}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          data-testid="password-reveal"
          aria-label={revealLabel(shown)}
          aria-pressed={shown}
          title={revealLabel(shown)}
          onClick={() => setShown((now) => !now)}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
        >
          {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {children}
    </div>
  );
}
