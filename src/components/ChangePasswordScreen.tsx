'use client';

import React, { useState } from 'react';
import AppLogo from '@/components/ui/AppLogo';
import PasswordField from '@/components/ui/PasswordField';
import { changePassword, signOut, type AuthSession } from '@/lib/authStore';
import { BUSINESS_NAME } from '@/lib/businessConfig';

// U11: a person whose password is the temporary one that the owner's command made sees this screen and nothing else; the API refuses
// every other call until the password is changed. The rules of a new password (U9) are the API's: this screen shows the reason it gives.
// The person can also sign out from here.
export default function ChangePasswordScreen({ session }: { session: AuthSession }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError('');
    if (next !== repeat) {
      setError('The two new passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      // On success the gate opens the app by itself; this screen is gone by then.
      const result = await changePassword(current, next);
      if (result.error) setError(result.error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="jewel-card w-full max-w-sm p-6 space-y-5">
        <div className="flex items-center gap-3">
          <AppLogo size={42} />
          <div>
            <h1 className="text-lg font-bold text-foreground">Choose a new password</h1>
            <p className="text-xs text-muted-foreground">
              {BUSINESS_NAME}: {session.displayName}
            </p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          The password you were given is for the first sign-in only. Choose one of your own to
          continue: at least 10 characters.
        </p>

        <div className="space-y-3">
          <PasswordField
            label="Current password"
            labelClassName="text-xs font-semibold text-muted-foreground block"
            inputClassName="input-field"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            required
          />
          <PasswordField
            label="New password"
            labelClassName="text-xs font-semibold text-muted-foreground block"
            inputClassName="input-field"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            required
          />
          <PasswordField
            label="Repeat the new password"
            labelClassName="text-xs font-semibold text-muted-foreground block"
            inputClassName="input-field"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            autoComplete="new-password"
            required
          />
          {error && (
            <p role="alert" className="text-xs font-semibold text-red-600">
              {error}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60"
          >
            {submitting ? 'Changing...' : 'Change password'}
          </button>
          <button type="button" className="btn-secondary py-2.5" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </form>
    </main>
  );
}
