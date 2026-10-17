'use client';

import React, { useState } from 'react';
import AppLogo from '@/components/ui/AppLogo';
import { signIn } from '@/lib/authStore';
import { BUSINESS_NAME } from '@/lib/businessConfig';

// U1: e-mail and password at the API's own login. The screen shows no credentials and no clues, and starts empty.
// `notice` is why the person is back here: the session ended (a deactivated account, a session past its limit) or the 12-hour idle
// logout (U4, C16). A wrong password and "Your account is not active" are the answer of the login itself, shown under the fields.
export default function LoginScreen({ notice }: { notice: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      // On success the gate moves on by itself (the state of the session changes); this screen is gone by then.
      const result = await signIn(email, password);
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
            <h1 className="text-lg font-bold text-foreground">{BUSINESS_NAME}</h1>
            <p className="text-xs text-muted-foreground">Sign in</p>
          </div>
        </div>

        <div className="space-y-3">
          {notice && !error && (
            <p role="status" className="text-xs font-semibold text-amber-700">
              {notice}
            </p>
          )}
          <label className="text-xs font-semibold text-muted-foreground block">
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="input-field mt-1"
              autoComplete="username"
              required
            />
          </label>
          <label className="text-xs font-semibold text-muted-foreground block">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="input-field mt-1"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-xs font-semibold text-red-600">
              {error}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="btn-primary w-full justify-center py-2.5 disabled:opacity-60"
        >
          {submitting ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </main>
  );
}
